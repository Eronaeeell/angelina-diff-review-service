# Submission

## Architecture (~10 lines)

Node.js + TypeScript + Express, single process, in-memory state. A request to
`POST /v1/reviews` validates the body, parses the unified diff into per-file
blocks (`src/diff/parser.ts`, tracking new-file line numbers across hunks),
registers a `Job`, and hands it to a concurrency-bounded worker queue
(`src/jobs/queue.ts`, limit 4). The worker chunks the diff on file boundaries
at 64KiB (`src/diff/chunker.ts`), runs each chunk through the selected
provider (`src/providers/mock.ts` or `src/providers/llm.ts`), then
dedupes+sorts+truncates the combined findings and appends `status`/`finding`/
`done` events to an in-memory per-job event log. `GET /v1/reviews/:id` reads
current job state; `GET /v1/reviews/:id/stream` replays that event log to any
SSE connection (whether it arrives mid-processing or after completion) and
then tails live events until `done`. Idempotency and caching are two
separate maps: `Idempotency-Key` → job id (keyed on the raw request-body
hash), and a semantic content hash of `{diff, resolved options}` → cached
result (for `cacheHit`).

## Provider design

Both providers implement one interface — `reviewChunk(files, addedLines,
lineRecordsByPath) -> Finding[]` — so chunking, ordering, dedup, caching, and
streaming are identical regardless of provider; only what happens inside a
chunk differs.

- **mock**: pure regex/line-based rule engine, no I/O, so it's instant and
  fully deterministic. The one rule that isn't a single-line regex —
  MOCK-004 (empty catch) — walks physical lines (added + context, in source
  order) from an added `catch (...) {` line, tracking brace depth until it
  returns to zero, flagging the line only if everything seen along the way
  besides whitespace/braces was empty. This covers same-line (`catch(e){}`),
  multi-line, and a close brace that's an unchanged context line, without a
  real parser.
- **llm**: vendor-agnostic — anything OpenAI-compatible (OpenRouter, Groq,
  OpenAI) works by setting `LLM_BASE_URL`; `LLM_VENDOR=anthropic` switches to
  Anthropic's native Messages API. The model is asked to return findings as a
  JSON array matching the `Finding` shape; the response is defensively
  parsed (strips markdown fences, validates each field, drops anything
  malformed rather than crashing on it). A configured `LLM_FALLBACK_MODEL`
  is retried once if the primary model call fails; if both fail (bad key,
  network error, timeout, malformed response), `reviewChunk` throws and the
  job resolves to `status: "failed"` with the underlying error message —
  the process itself never crashes. The prompt explicitly tells the model
  the diff is untrusted data, not instructions, as a second layer under the
  mock provider's literal MOCK-INJ detection.

## How I verified the cross-cutting behaviors

`test/verify.mjs` is an assertion-based suite (39 checks, run against a live
instance) rather than unit tests against internal functions, because the
contract is explicitly a black-box HTTP contract. It covers: every mock rule
individually (including same-line/multi-line/negative empty-catch cases),
cross-file/cross-line ordering + no-duplicate-ids, `maxFindings` truncation
vs. `usage` reflecting the full scan, the full error taxonomy (401/413/400/
422/404/409), idempotency (same key+body → same jobId; same key+different
body → 409), caching (`cacheHit` + identical findings on byte-identical
resubmission), chunking on a >64KiB/4-file diff (asserts `usage.chunks > 1`),
SSE replay (finding events from a completed job's stream compared
byte-for-byte against the poll endpoint's `findings`), and 5-way concurrent
submission (all return 202; a 5th queues instead of failing).

Running this suite twice back-to-back against the same process is itself
what caught a real bug: the first rate-limit burst size I chose (10) was too
small — a legitimate run of ~28 rapid correctness-check requests started
getting wrongly 429'd partway through. Fixed by raising the burst to 30 (one
full minute's sustained quota up front), which is documented in the git
history rather than silently changed.

## AI tools used

Built end-to-end with Claude Code (Sonnet 5) — this file included. I paired
on the diff parser and chunker design, wrote the provider interface and mock
rule table by hand-checking each regex against the spec's literal wording,
and iterated verification by actually running the service and reading real
HTTP responses rather than trusting the implementation on faith.

## An AI suggestion I rejected

The first draft of the empty-catch rule (MOCK-004) matched only added lines
in a simple two-line lookahead window. That would have missed a catch block
whose closing brace is an unchanged context line, and would have
misattributed depth when a line reads `} catch (e) {` (closing the `try`
and opening the `catch` on the same line). I rejected the shortcut in favor
of proper brace-depth tracking starting from the position right after
`catch(...) {` specifically, walking forward through added-or-context lines
until depth returns to zero — more code, but it's the only version that
doesn't misfire on realistic diffs.

## What I'd do next with more time

- Persist job/cache/idempotency state (currently in-memory only) so a
  process restart mid-window doesn't lose in-flight jobs.
- Parallelize chunk processing for the `llm` provider (currently sequential)
  to cut latency on large diffs.
- Per-token-bearer rate limiting instead of one process-wide bucket (fine
  for a single evaluator token, not for multi-tenant use).
- A real parser (e.g. a lightweight JS/TS AST pass) instead of regex/brace
  heuristics for MOCK-004 and MOCK-003, to remove the remaining edge cases
  a determined adversarial diff could exploit.
