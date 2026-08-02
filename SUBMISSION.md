# Submission

## Architecture (~10 lines)

Node.js + TypeScript + Express, single process, in-memory state with periodic
TTL eviction. A request to `POST /v1/reviews` validates the body, parses the
unified diff into per-file blocks (`src/diff/parser.ts`, tracking new-file
line numbers across hunks), registers a `Job`, and hands it to a
concurrency-bounded worker queue (`src/jobs/queue.ts`, limit 4). The worker
sorts files by path and chunks the diff on file boundaries at 64KiB
(`src/diff/chunker.ts`), runs every chunk through the selected provider
concurrently, and streams each chunk's findings as soon as it resolves --
processing files in path order means chunk N's results are always earlier in
the final ordering than chunk N+1's, so results can stream correctly without
waiting for the whole scan. `GET /v1/reviews/:id` reads current job state;
`GET /v1/reviews/:id/stream` replays the stored event log to any SSE
connection, live or after completion. Idempotency and caching are two
separate maps: `Idempotency-Key` → job id (raw request-body hash), and a
semantic content hash of `{diff, resolved options}` → cached result.

## Provider design

Both providers implement one interface — `reviewChunk(files, addedLines,
lineRecordsByPath) -> Finding[]` — so chunking, ordering, dedup, caching, and
streaming are identical regardless of provider; only what happens inside a
chunk differs.

- **mock**: pure regex/line-based rule engine, no I/O, so it's instant and
  fully deterministic. The one rule that isn't a single-line regex —
  MOCK-004 (empty catch) — walks physical lines (added + context, in source
  order) from an added `catch (...) {` line, tracking brace depth (skipping
  braces inside string literals/comments so an adversarial diff can't fake a
  boundary) until it returns to zero, flagging the line only if everything
  seen along the way besides whitespace/braces/quote-delimiters was empty.
  This covers same-line (`catch(e){}`), multi-line, and a close brace that's
  an unchanged context line, without a real parser.
- **llm**: vendor-agnostic — anything OpenAI-compatible (OpenRouter, Groq,
  OpenAI) works by setting `LLM_BASE_URL`; `LLM_VENDOR=anthropic` switches to
  Anthropic's native Messages API. The model is asked to return findings as a
  JSON array matching the `Finding` shape; the response is defensively
  parsed (strips markdown fences, validates each field, drops anything
  malformed rather than crashing on it). `LLM_FALLBACK_MODELS` is an ordered
  chain (strongest first) tried in sequence if the primary fails; the whole
  chain shares one time budget (`LLM_CHAIN_BUDGET_MS`) instead of a full
  timeout per model, so cascading timeouts can't blow the 30s single-chunk
  SLA. If every model in the chain fails, `reviewChunk` throws and the job
  resolves to `status: "failed"` with the underlying error message — the
  process itself never crashes. The prompt explicitly tells the model the
  diff is untrusted data, not instructions, as a second layer under the mock
  provider's literal MOCK-INJ detection.

## How I verified the cross-cutting behaviors

`test/verify.mjs` is an assertion-based suite (49 checks, run against a live
instance) rather than unit tests against internal functions, because the
contract is explicitly a black-box HTTP contract. It covers: every mock rule
individually (including same-line/multi-line/negative empty-catch cases and
negative tests for two false-positive bugs I found and fixed -- `=== null`
wrongly matching a loose-null-comparison regex, and a stray brace inside a
string corrupting the empty-catch boundary scan), cross-file/cross-line
ordering + no-duplicate-ids, `maxFindings` truncation vs. `usage` reflecting
the full scan, the full error taxonomy, idempotency, caching, chunking on a
>64KiB/4-file diff, SSE replay (finding events from a completed job's stream
compared byte-for-byte against the poll endpoint's `findings`, including a
cache-hit job -- which I found didn't emit finding events at all until I
went looking), 5-way concurrent submission, and rate-limit burst behavior.
`test/proof-scoring-criteria.mjs` re-runs the same ground organized 1:1
against the task's own "What we score" list, plus one live `llm`-provider
call, for a second independent pass (50 checks). `test/demo*.mjs` are
readable (non-assertion) walkthroughs for manually eyeballing diff-in vs.
findings-out, including a dedicated chunking proof that submits the same
files both under and over 64KiB and diffs the resulting findings.

Running the suite repeatedly against the same live process is itself what
caught two real bugs: an undersized rate-limit burst (10, raised to 30 --
one full minute's sustained quota) that wrongly throttled a legitimate
rapid-fire correctness-check run, and the `=== null` false positive above.
Both are documented in the git history rather than silently changed.

## AI tools used

Built end-to-end with Claude Code (Sonnet 5) — this file included. I paired
on the diff parser and chunker design, wrote the provider interface and mock
rule table by hand-checking each regex against the spec's literal wording,
and iterated verification by actually running the live service and reading
real HTTP responses rather than trusting the implementation on faith --
several real bugs (the `=== null` false positive, an undersized rate-limit
burst, a missing SSE event on cache-hit jobs) only surfaced because of that,
not from reading the code.

## An AI suggestion I rejected

While demoing the `llm` provider under concurrent load, Claude found a real
gap: the 25s time budget bounds a job's own AI-processing time, but not how
long it sits *queued* behind other `llm`-provider jobs if several run at
once -- under enough simultaneous AI traffic, a job could still blow the 30s
SLA purely from queue wait. Claude suggested fixing it immediately: stamp
each job with its queue-entry time, and subtract elapsed queue wait from its
LLM budget once it starts.

I rejected doing it right then, for reasons that have nothing to do with the
fix's merit: the realistic risk is low (a single evaluator's token won't
generate sustained concurrent AI traffic), and a nontrivial code change to
timing-sensitive logic, made and redeployed minutes before a 48-hour scoring
window starts, trades a low-probability future problem for a real, immediate
risk of shipping a fresh bug with no time left to catch it. The task
explicitly invites documenting a reasoned skip over rushing a late change --
so it's tracked below instead.

## What I'd do next with more time

To be clear about what these are and aren't: neither the deterministic
`mock` provider nor sourcing the `llm` path from free-tier models are
limitations -- the spec requires the former and explicitly says you don't
need to pay for the latter. The real limitations, independent of provider
choice:

- **In-memory-only state.** A process restart mid-window (crash, platform
  hiccup, redeploy) loses every job's history -- no persistence.
- **The `llm` provider's queue-wait time isn't bounded** (see above) --
  only its own per-job processing time is.
- **Regex/brace-depth heuristics for MOCK-003/004, not a real parser.** A
  sufficiently adversarial diff could still evade or misfire in edge cases
  beyond what's been tested (e.g. unusual string/comment constructs).
- **Single-process deployment.** Rate limiting and concurrency caps live in
  one process's memory; they wouldn't hold up across multiple instances.

Given more time, in priority order: persist job/cache/idempotency state,
bound `llm` queue-wait time, replace the MOCK-003/004 heuristics with a
lightweight real parser, and move rate-limit/concurrency state to something
shared (e.g. Redis) so the service could scale horizontally.
