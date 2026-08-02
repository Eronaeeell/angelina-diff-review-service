import { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { Errors } from "../errors";

// Token bucket: capacity = burst, refill = rateLimitPerMinute per 60s.
// At exactly the sustained rate, tokens refill as fast as they're spent,
// so 30 evenly-paced requests/minute never exhaust the bucket.
const REFILL_PER_MS = config.rateLimitPerMinute / 60000;

let tokens = config.rateLimitBurst;
let lastRefill = Date.now();

function refill(): void {
  const now = Date.now();
  const elapsed = now - lastRefill;
  if (elapsed <= 0) return;
  tokens = Math.min(config.rateLimitBurst, tokens + elapsed * REFILL_PER_MS);
  lastRefill = now;
}

export function rateLimitMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  refill();
  if (tokens >= 1) {
    tokens -= 1;
    next();
    return;
  }
  const deficit = 1 - tokens;
  const waitMs = deficit / REFILL_PER_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
  next(Errors.rateLimited(retryAfterSeconds));
}
