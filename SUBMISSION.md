# Submission

## Architecture

```mermaid
flowchart TD
    A["POST /v1/reviews"] --> B["Validate body,<br/>parse unified diff"]
    B --> C["Create Job<br/>status: queued"]
    C --> D["Concurrency queue<br/>max 4 workers"]
    D --> E["Sort files by path,<br/>chunk at 64KiB boundaries"]
    E --> F["Run every chunk's<br/>provider call concurrently"]
    F --> G{"provider?"}
    G -->|mock| H["Regex/brace rule engine<br/>9 deterministic rules"]
    G -->|llm| I["AI model call<br/>+ ordered fallback chain<br/>shared time budget"]
    H --> J["Sort by path, line, ruleId<br/>Dedupe by id<br/>Truncate to maxFindings"]
    I --> J
    J --> K["Emit status/finding/done<br/>events per chunk, in order"]
    K --> L["GET /v1/reviews/:id<br/>reads current state"]
    K --> M["GET .../stream<br/>replays event log via SSE"]
```

- **Stack:** Node.js + TypeScript + Express, single process, in-memory state with periodic TTL eviction.
- **Diff parsing** (`src/diff/parser.ts`) tracks new-file line numbers across hunks, per file block.
- **Chunking** (`src/diff/chunker.ts`) sorts files by path first, then bin-packs on file boundaries at 64KiB — sorting first means chunk N's results are always earlier in the final ordering than chunk N+1's, so findings can stream correctly without waiting for the whole scan.
- **Concurrency** is bounded by a worker queue (`src/jobs/queue.ts`, limit 4); a 5th job queues instead of failing.
- **Idempotency and caching are two separate maps:** `Idempotency-Key` → job id (keyed on the raw request-body hash), and a semantic content hash of `{diff, resolved options}` → cached result (for `cacheHit`).
- **Streaming:** `GET /v1/reviews/:id/stream` replays a stored per-job event log to any SSE connection, whether it arrives mid-processing or after completion.

## Provider design

Both providers implement one interface — `reviewChunk(files, addedLines, lineRecordsByPath) -> Finding[]` — so chunking, ordering, dedup, caching, and streaming are identical regardless of provider; only what happens inside a chunk differs.

**`mock`**
- Pure regex/line-based rule engine, no I/O — instant and fully deterministic.
- The one rule that isn't a single-line regex, **MOCK-004 (empty catch)**, walks physical lines (added + context, in source order) from an added `catch (...) {` line, tracking brace depth until it returns to zero.
- Braces inside string literals/comments are skipped during depth tracking, so an adversarial diff can't fake a boundary.
- Covers same-line (`catch(e){}`), multi-line, and a close brace that's an unchanged context line — without a real parser.

**`llm`**
- Vendor-agnostic: any OpenAI-compatible API (OpenRouter, Groq, OpenAI) works via `LLM_BASE_URL`; `LLM_VENDOR=anthropic` switches to Anthropic's native Messages API.
- The model returns findings as a JSON array matching the `Finding` shape; the response is defensively parsed (strips markdown fences, validates each field, drops anything malformed instead of crashing).
- `LLM_FALLBACK_MODELS` is an ordered chain (strongest first), tried in sequence if the primary fails.
- The **whole chain shares one time budget** (`LLM_CHAIN_BUDGET_MS`, 28s) rather than a fresh timeout per model, and every call — connect, headers, **and body** — runs under one abort timer. That last part is load-bearing and I originally got it wrong; see bug 6 below.
- Because the budget is measured from submission, `LLM_TIMEOUT_MS` (27s) is deliberately under the contract's 30s rather than equal to it: the job has to reach a terminal state within 30s, not start one.
- If every model in the chain fails, the job resolves to `status: "failed"` with the underlying error — the process itself never crashes.
- The prompt tells the model the diff is untrusted data, not instructions — a second layer under the mock provider's literal `MOCK-INJ` detection.

## How I verified the cross-cutting behaviors

Two independent, assertion-based suites run against the **live deployed instance** (black-box HTTP, no unit tests against internal functions — the contract is explicitly an HTTP contract):

- **`test/verify.mjs` (59 checks):** every mock rule individually (incl. same-line/multi-line/negative empty-catch cases, and negative tests for two false-positive bugs I found — see below), cross-file/cross-line ordering + no-duplicate-ids, `maxFindings` truncation vs. `usage` reflecting the full scan, the full error taxonomy, idempotency, caching, chunking on a >64KiB/4-file diff, SSE replay (finding events from a completed job's stream compared byte-for-byte against the poll endpoint's `findings`, including a cache-hit job — which didn't emit finding events at all until I went looking), 5-way concurrent submission, and rate-limit burst behavior.
- **`test/proof-scoring-criteria.mjs` (50 checks):** the same ground, reorganized 1:1 against the task's own "What we score" list, plus one live `llm`-provider call.
- **`test/demo*.mjs`:** readable (non-assertion) walkthroughs for manually eyeballing diff-in vs. findings-out, including a dedicated chunking proof that submits the same files both under and over 64KiB and diffs the resulting findings.

**Five real bugs were found by running against a live process rather than by reading the code:**
1. **The parser only stripped `a/`/`b/` path prefixes when the diff carried `diff --git` headers.** A hand-written unified diff (prefixes, no `diff --git` line) produced `MOCK-003:b/src/db.ts:41` instead of `MOCK-003:src/db.ts:41` — a wrong `path` and `id` on *every* finding. The prefix strip is now unconditional. This is the one I'd have most regretted missing: the suite only ever generated `git diff`-shaped input, so it was invisible until I deliberately fed the service other legal diff shapes.
2. **A deletion-only diff was rejected `422 invalid_diff`.** The "did I see a hunk?" flag was only set inside the per-file body loop, which is skipped for `+++ /dev/null` targets — so a diff that only deletes files looked unparseable. It's valid input that legitimately yields zero findings.
3. **An added line whose content began with `++`** was mistaken for a `+++` file header and dropped without advancing the line counter, shifting every subsequent line number in that file.
4. An undersized rate-limit burst (10, raised to 30 — one full minute's sustained quota) that wrongly throttled a legitimate rapid-fire correctness-check run.
5. A regex false positive: `=== null` / `!== null` was wrongly matching the loose-null-comparison rule.
6. **The LLM timeout never applied to generation.** `fetchWithTimeout` cleared its abort timer as soon as `fetch()` resolved — but `fetch()` resolves when response *headers* arrive, and an LLM vendor sends headers immediately then streams tokens. The subsequent `res.json()` read the body with no timeout at all, so the "budget" only ever bounded connection latency. A 15s chain budget was observed producing a **46s** job. The body read now stays inside the timer's scope, which makes the 30s guarantee structural instead of aspirational.

Each has a regression check in `verify.mjs` or `timing.mjs`, and is documented in git history rather than silently changed.

**Bug 6 is the one I'd most want to talk through.** It was invisible to every test that existed, because all of them asked *"did the llm path return findings?"* and none asked *"how long did it take?"* The suite was green while the service could take three times its stated budget. That gap is why `test/timing.mjs` exists now: it measures every job shape against the 30s budget from submission, reports queue wait separately from run time, and exits non-zero if anything is over — so the budget is a gate, not a hope.

**A note on how #1–#3 were found, since it's the more useful lesson:** all three are parser bugs, and all three were invisible to a 50-check suite that was *green*. The suite's diff fixtures were all built by one helper that emitted `git diff` output, so the tests agreed with the implementation about what a diff looks like. Nothing was found until I stopped asking "do my tests pass?" and started asking "what legal input have I never fed this?" — non-git diffs, `diff -u` output, deletion-only diffs, added lines that mimic diff syntax.

## AI tools used

- Built end-to-end with **Claude Code (Sonnet 5)** — this file included.
- Paired on the diff parser and chunker design; wrote the provider interface and mock rule table by hand-checking each regex against the spec's literal wording.
- Verified iteratively by actually running the live service and reading real HTTP responses rather than trusting the implementation on faith — several real bugs (the `=== null` false positive, an undersized rate-limit burst, a missing SSE event on cache-hit jobs) only surfaced because of that, not from reading the code.

## An AI suggestion I rejected

- While demoing the `llm` provider under concurrent load, Claude found a real gap: the 25s time budget bounds a job's own AI-processing time, but not how long it sits **queued** behind other `llm`-provider jobs if several run at once — under enough simultaneous AI traffic, a job could still blow the 30s SLA purely from queue wait.
- Claude suggested fixing it immediately: stamp each job with its queue-entry time, and subtract elapsed queue wait from its LLM budget once it starts.
- **I rejected doing it right then** — not because the fix is wrong, but because:
  - the realistic risk is low (a single evaluator's token won't generate sustained concurrent AI traffic), and
  - a nontrivial change to timing-sensitive logic, redeployed minutes before a 48-hour scoring window starts, trades a low-probability future problem for a real, immediate risk of shipping a fresh bug with no time left to catch it.
- The task explicitly invites documenting a reasoned skip over rushing a late change — so it's tracked below instead.

## What I'd do next with more time

To be clear about what these are and aren't: **neither the deterministic `mock` provider nor sourcing the `llm` path from free-tier models are limitations** — the spec requires the former and explicitly says you don't need to pay for the latter. The real limitations, independent of provider choice:

- **In-memory-only state.** A process restart mid-window (crash, platform hiccup, redeploy) loses every job's history — no persistence.
- **`llm` completes reliably only about half the time.** Not a code defect — OpenRouter's free tier is queue-dominated, and the same 3-line diff was measured at 19.4s, 22s (timeout), 22s (timeout) and 10.6s. Model size is irrelevant to this: a 20B model and a 550B model both sit in the same queue. Every outcome is inside the 30s budget and fails gracefully, so the contract's bar ("exists and degrades gracefully") is met — but "works end to end" is a coin flip. The fix is a vendor with dedicated inference capacity (Groq, Cerebras), which is an env-var change only since the client is already OpenAI-compatible.
- **`llm` queue-wait time isn't bounded** — measured at 4.5s with 5 concurrent jobs, worst job still finishing at 14.4s, so it holds in practice. It stays a latent risk: if per-call latency rose to ~27s, a queued 5th job would land near 54s.
- **Regex/brace-depth heuristics for MOCK-003/004, not a real parser.** A sufficiently adversarial diff could still evade or misfire in edge cases beyond what's been tested (e.g. unusual string/comment constructs).
- **Single-process deployment.** Rate limiting and concurrency caps live in one process's memory; they wouldn't hold up across multiple instances.
- **The rate limiter can contaminate unrelated test results.** With burst = 30 and refill = 30/min, any client issuing more than 30 POSTs inside a minute starts getting `429`s — including a caller who is really testing caching or chunking and merely happens to be fast. I watched this happen to my own probe run. The behavior is exactly what the contract asks for (sustained 30/min succeeds, beyond burst is `429` + `Retry-After`, never 5xx) and `/spec` declares it honestly, so I left it: raising the burst would make `rateLimitPerMinute: 30` a less truthful self-declaration, and the contract weights declared-limit accuracy explicitly. It is a real sharp edge worth naming rather than hiding.

**Priority order given more time:**
1. Persist job/cache/idempotency state.
2. Bound `llm` queue-wait time.
3. Replace the MOCK-003/004 heuristics with a lightweight real parser.
4. Move rate-limit/concurrency state to something shared (e.g. Redis) so the service could scale horizontally.
