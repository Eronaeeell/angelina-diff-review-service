import { NextFunction, Request, Response, Router } from "express";
import { config } from "../config";
import { Errors, errorEnvelope } from "../errors";
import { rateLimitMiddleware } from "../middleware/rateLimit";
import { parseUnifiedDiff } from "../diff/parser";
import { processJob } from "../jobs/processor";
import { jobQueue } from "../jobs/queue";
import {
  bodyHash,
  contentHash,
  createJob,
  emitEvent,
  getCached,
  getIdempotencyEntry,
  getJob,
  newJobId,
  setCached,
  setIdempotencyEntry,
} from "../jobs/store";
import { ProviderName, ReviewOptions } from "../types";

const router = Router();

router.post("/v1/reviews", rateLimitMiddleware, (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawBody: Buffer | undefined = (req as any).rawBody;
    const bodyText = rawBody ? rawBody.toString("utf8") : JSON.stringify(req.body ?? {});
    const hash = bodyHash(bodyText);
    const idemKey = req.header("Idempotency-Key");

    if (idemKey) {
      const existing = getIdempotencyEntry(idemKey);
      if (existing) {
        if (existing.bodyHash !== hash) {
          throw Errors.idempotencyConflict();
        }
        res.status(202).json({ jobId: existing.jobId, status: "queued" });
        return;
      }
    }

    const body = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Errors.invalidDiff("Request body must be a JSON object");
    }

    const diff = (body as any).diff;
    if (typeof diff !== "string" || diff.trim().length === 0) {
      throw Errors.invalidDiff("diff is missing or empty");
    }

    const optionsRaw = (body as any).options;
    if (optionsRaw !== undefined && (typeof optionsRaw !== "object" || optionsRaw === null || Array.isArray(optionsRaw))) {
      throw Errors.invalidDiff("options must be a JSON object");
    }
    const rawOptions = (optionsRaw ?? {}) as Record<string, unknown>;

    let provider: ProviderName = "mock";
    if (rawOptions.provider !== undefined) {
      if (rawOptions.provider !== "mock" && rawOptions.provider !== "llm") {
        throw Errors.invalidDiff('options.provider must be "mock" or "llm"');
      }
      provider = rawOptions.provider;
    }

    let maxFindings = config.defaultMaxFindings;
    if (rawOptions.maxFindings !== undefined) {
      const n = rawOptions.maxFindings;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw Errors.invalidDiff("options.maxFindings must be a non-negative integer");
      }
      maxFindings = n;
    }
    const options: ReviewOptions = { provider, maxFindings };

    const parsed = parseUnifiedDiff(diff);
    if (!parsed) {
      throw Errors.invalidDiff();
    }

    const cHash = contentHash(diff, options);
    const jobId = newJobId();
    const cached = getCached(cHash);

    if (cached) {
      const job = createJob(jobId, diff, options, cHash);
      job.findings = cached.findings;
      job.usage = { ...cached.usage, cacheHit: true };
      job.status = "done";
      for (const finding of job.findings) {
        emitEvent(job, { event: "finding", data: finding });
      }
      emitEvent(job, { event: "status", data: { status: "done" } });
      emitEvent(job, { event: "done", data: { total: job.findings.length, usage: job.usage } });
      if (idemKey) setIdempotencyEntry(idemKey, hash, jobId);
      res.status(202).json({ jobId, status: "queued" });
      return;
    }

    const job = createJob(jobId, diff, options, cHash);
    emitEvent(job, { event: "status", data: { status: "queued" } });
    if (idemKey) setIdempotencyEntry(idemKey, hash, jobId);

    jobQueue.push(async () => {
      await processJob(job);
      if (job.status === "done") {
        setCached(cHash, {
          findings: job.findings,
          usage: { inputBytes: job.usage.inputBytes, chunks: job.usage.chunks, cacheHit: false },
        });
      }
    });

    res.status(202).json({ jobId, status: "queued" });
  } catch (err) {
    next(err);
  }
});

router.get("/v1/reviews/:jobId", (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json(errorEnvelope("not_found", "No job with that id"));
    return;
  }

  const response: Record<string, unknown> = {
    jobId: job.jobId,
    status: job.status,
    usage: job.usage,
  };
  if (job.status === "done") response.findings = job.findings;
  if (job.status === "failed" && job.error) response.error = job.error;

  res.status(200).json(response);
});

export default router;
