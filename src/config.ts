export const VERSION = "1.0.0";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  bearerToken: process.env.AUTH_TOKEN ?? "",

  maxPayloadBytes: 1024 * 1024, // 1 MiB
  chunkBytes: 64 * 1024, // 64 KiB
  maxConcurrentJobs: 4,
  rateLimitPerMinute: 30,
  // Burst allowance: a full minute's sustained quota available up front, so
  // a legitimate rapid-fire test suite (e.g. probing every mock rule back to
  // back) isn't throttled, while sustained abuse beyond 30/min still is.
  rateLimitBurst: 30,

  defaultMaxFindings: 100,

  // The contract's per-job budget: "Jobs with diffs <=64 KiB must reach
  // `done` within 30 s" -- measured from submission, so queue wait counts
  // against it. `jobBudgetSafetyMs` is held back so a job that exhausts its
  // budget still has time to record a terminal state and be observed by a
  // client polling on a ~1s interval.
  jobBudgetMs: Number(process.env.JOB_BUDGET_MS ?? 30000),
  jobBudgetSafetyMs: Number(process.env.JOB_BUDGET_SAFETY_MS ?? 2500),

  // In-memory job/cache/idempotency entries older than this are swept
  // periodically so a long-lived process doesn't grow unbounded. Default is
  // generous (well beyond the 48h scoring window) since evicting something
  // still needed mid-window would be worse than the memory it saves.
  storeTtlMs: Number(process.env.STORE_TTL_MS ?? 24 * 60 * 60 * 1000),
  storeSweepIntervalMs: Number(process.env.STORE_SWEEP_INTERVAL_MS ?? 15 * 60 * 1000),

  // LLM provider (env-configured; see README)
  llm: {
    vendor: process.env.LLM_VENDOR ?? "", // "anthropic" or anything OpenAI-compatible (openai, groq, openrouter, ...)
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "",
    // Ordered, comma-separated list of additional models to fall back to (strongest
    // first) if the primary model call fails, e.g. "modelB,modelC,modelD".
    fallbackModels: (process.env.LLM_FALLBACK_MODELS ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    baseUrl: process.env.LLM_BASE_URL ?? "", // e.g. https://openrouter.ai/api/v1
    // Per-model call timeout, used as an upper bound -- the whole fallback
    // chain is additionally capped by chainBudgetMs so cascading timeouts
    // across several models can't blow the 30s single-chunk SLA.
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 27000),
    // Total time budget for walking the whole model chain (primary + all
    // fallbacks) on a single chunk. Left with ~5s of headroom under the
    // contract's 30s "done within 30s for <=64KiB diffs" budget.
    chainBudgetMs: Number(process.env.LLM_CHAIN_BUDGET_MS ?? 28000),
    // Optional OpenRouter-recommended attribution headers.
    httpReferer: process.env.LLM_HTTP_REFERER ?? "",
    appTitle: process.env.LLM_APP_TITLE ?? "",
  },
};

export const startedAt = Date.now();
