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
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 20000),
    // Optional OpenRouter-recommended attribution headers.
    httpReferer: process.env.LLM_HTTP_REFERER ?? "",
    appTitle: process.env.LLM_APP_TITLE ?? "",
  },
};

export const startedAt = Date.now();
