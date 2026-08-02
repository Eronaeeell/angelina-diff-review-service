# AI Diff Review Service

Async HTTP service that reviews unified diffs and returns structured findings,
via a `mock` (deterministic rule engine) or `llm` (real model) provider behind
the same pipeline. Built for the take-home contract in `CANDIDATE-TASK.md`.

See `SUBMISSION.md` for architecture notes, verification approach, and AI-tool usage.

## Stack

Node.js 22 + TypeScript + Express. In-memory job store/cache/idempotency map
(no external DB — see SUBMISSION.md for the tradeoff).

## Running locally

```bash
npm install
cp .env.example .env   # fill in AUTH_TOKEN at minimum
npm run dev             # tsx watch, or:
npm run build && npm start
```

## Environment variables

| Var | Required | Description |
|---|---|---|
| `PORT` | no (default 3000) | HTTP port |
| `AUTH_TOKEN` | yes | Bearer token clients must send for all `/v1/*` routes |
| `LLM_VENDOR` | no | `anthropic` for Anthropic's native Messages API; anything else (or unset) uses an OpenAI-compatible chat-completions call, which covers OpenRouter, Groq, OpenAI itself, etc. |
| `LLM_API_KEY` | only for `llm` provider | API key for the vendor |
| `LLM_MODEL` | only for `llm` provider | Primary (strongest) model id |
| `LLM_FALLBACK_MODELS` | no | Comma-separated ordered fallback chain, strongest first; tried in order if the primary fails, before the job is marked `failed` |
| `LLM_BASE_URL` | no | Override API base (e.g. `https://openrouter.ai/api/v1`) |
| `LLM_TIMEOUT_MS` | no (default 20000) | Per-model-call timeout ceiling |
| `LLM_CHAIN_BUDGET_MS` | no (default 25000) | Shared time budget for the whole primary+fallback chain on one chunk, so cascading timeouts can't blow the 30s single-chunk SLA |
| `LLM_HTTP_REFERER`, `LLM_APP_TITLE` | no | Optional OpenRouter attribution headers |
| `STORE_TTL_MS` | no (default 24h) | Age at which in-memory jobs/cache/idempotency entries are evicted |
| `STORE_SWEEP_INTERVAL_MS` | no (default 15min) | How often the eviction sweep runs |

If `llm` is requested and the model is unreachable/misconfigured, the job
resolves to `status: "failed"` with a clear error — the process never crashes.

## Rate limiting

`POST /v1/reviews` is limited with a token-bucket, keyed per bearer token:
capacity (burst) of 30 requests, refilling at 30/minute (matches the
declared `rateLimitPerMinute`). A sustained 30 req/min always succeeds; a
burst above 30 in-flight gets `429` + `Retry-After` until tokens refill.
GETs are never rate limited. Burst size intentionally equals a full minute's
quota so a rapid-fire correctness-check suite (e.g. one request per mock
rule, back to back) isn't wrongly throttled -- see SUBMISSION.md.

## Project layout

```
src/
  app.ts, index.ts       Express app assembly + entrypoint
  config.ts               env-derived limits/config
  errors.ts                error envelope + AppError
  types.ts                  shared types
  diff/parser.ts            unified diff -> per-file blocks + added lines
  diff/chunker.ts           64KiB file-boundary bin-packing
  providers/mock.ts         deterministic rule engine (MOCK-001..008, MOCK-INJ)
  providers/llm.ts          vendor-agnostic LLM call + graceful failure
  jobs/store.ts             in-memory jobs, cache, idempotency map
  jobs/queue.ts             concurrency-bounded worker queue
  jobs/processor.ts         parse -> chunk -> provider -> aggregate -> emit
  routes/                   health, spec, reviews (POST/GET), stream (SSE)
  middleware/                auth, rate limit, error handler
test/
  fixtures/                 sample diffs
  verify.mjs                 end-to-end contract verification suite (see SUBMISSION.md)
```

## Deployment

Deployed on Railway (always-on process — required for SSE + background job
processing + in-memory state, none of which fit a serverless/edge model).
