export const VERSION = "1.0.0";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  bearerToken: process.env.AUTH_TOKEN ?? "",

  maxPayloadBytes: 1024 * 1024, // 1 MiB
  chunkBytes: 64 * 1024, // 64 KiB
  maxConcurrentJobs: 4,
  rateLimitPerMinute: 30,
  // Burst allowance above the sustained per-minute rate before we start
  // returning 429s. Sized so 30 evenly-ish spaced requests/min always pass,
  // while a caller firing many requests instantly still gets throttled.
  rateLimitBurst: 10,

  defaultMaxFindings: 100,

  // LLM provider (env-configured; see README)
  llm: {
    vendor: process.env.LLM_VENDOR ?? "", // e.g. "anthropic", "openai", "groq"
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "",
    baseUrl: process.env.LLM_BASE_URL ?? "", // optional override
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 20000),
  },
};

export const startedAt = Date.now();
