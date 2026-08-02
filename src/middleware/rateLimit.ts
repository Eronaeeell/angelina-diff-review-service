import { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { Errors } from "../errors";

// Token bucket: capacity = burst, refill = rateLimitPerMinute per 60s.
// At exactly the sustained rate, tokens refill as fast as they're spent,
// so 30 evenly-paced requests/minute never exhaust the bucket.
const REFILL_PER_MS = config.rateLimitPerMinute / 60000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

// Keyed per bearer token so one caller's traffic can't throttle another's,
// even though this deployment is only ever exercised by a single evaluator
// token. Runs after authMiddleware (mounted on all of /v1/*), so the token
// is already validated by the time this reads it.
const buckets = new Map<string, Bucket>();

function getBucket(token: string): Bucket {
  let bucket = buckets.get(token);
  if (!bucket) {
    bucket = { tokens: config.rateLimitBurst, lastRefill: Date.now() };
    buckets.set(token, bucket);
  }
  return bucket;
}

function refill(bucket: Bucket): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  if (elapsed <= 0) return;
  bucket.tokens = Math.min(config.rateLimitBurst, bucket.tokens + elapsed * REFILL_PER_MS);
  bucket.lastRefill = now;
}

export function rateLimitMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const token = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1] ?? "unknown";
  const bucket = getBucket(token);

  refill(bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    next();
    return;
  }
  const deficit = 1 - bucket.tokens;
  const waitMs = deficit / REFILL_PER_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
  next(Errors.rateLimited(retryAfterSeconds));
}
