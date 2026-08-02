import crypto from "crypto";
import { config } from "../config";
import { Job, ReviewOptions, StreamEvent, Usage } from "../types";

interface CacheEntry {
  findings: Job["findings"];
  usage: Usage;
  createdAt: number;
}

interface IdempotencyEntry {
  bodyHash: string;
  jobId: string;
  createdAt: number;
}

const jobs = new Map<string, Job>();
const idempotencyMap = new Map<string, IdempotencyEntry>();
const cache = new Map<string, CacheEntry>();

export function contentHash(diff: string, options: ReviewOptions): string {
  const normalized = JSON.stringify({ diff, provider: options.provider, maxFindings: options.maxFindings });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function bodyHash(rawBody: string): string {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

export function newJobId(): string {
  return crypto.randomUUID();
}

export function createJob(jobId: string, diff: string, options: ReviewOptions, hash: string): Job {
  const job: Job = {
    jobId,
    status: "queued",
    diff,
    options,
    findings: [],
    usage: { inputBytes: Buffer.byteLength(diff, "utf8"), chunks: 0, cacheHit: false },
    events: [],
    createdAt: Date.now(),
    contentHash: hash,
    waiters: [],
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function getIdempotencyEntry(key: string): IdempotencyEntry | undefined {
  return idempotencyMap.get(key);
}

export function setIdempotencyEntry(key: string, hash: string, jobId: string): void {
  idempotencyMap.set(key, { bodyHash: hash, jobId, createdAt: Date.now() });
}

export function getCached(hash: string): CacheEntry | undefined {
  return cache.get(hash);
}

export function setCached(hash: string, entry: Omit<CacheEntry, "createdAt">): void {
  cache.set(hash, { ...entry, createdAt: Date.now() });
}

export function emitEvent(job: Job, event: StreamEvent): void {
  job.events.push(event);
  for (const waiter of job.waiters.slice()) waiter(event);
}

export function subscribe(job: Job, onEvent: (ev: StreamEvent) => void): () => void {
  job.waiters.push(onEvent);
  return () => {
    job.waiters = job.waiters.filter((w) => w !== onEvent);
  };
}

/** Evicts jobs/cache/idempotency entries older than config.storeTtlMs. */
export function sweepExpired(now: number = Date.now()): { jobs: number; cache: number; idempotency: number } {
  let jobsSwept = 0;
  let cacheSwept = 0;
  let idempotencySwept = 0;

  for (const [id, job] of jobs) {
    if (now - job.createdAt > config.storeTtlMs) {
      jobs.delete(id);
      jobsSwept++;
    }
  }
  for (const [hash, entry] of cache) {
    if (now - entry.createdAt > config.storeTtlMs) {
      cache.delete(hash);
      cacheSwept++;
    }
  }
  for (const [key, entry] of idempotencyMap) {
    if (now - entry.createdAt > config.storeTtlMs) {
      idempotencyMap.delete(key);
      idempotencySwept++;
    }
  }

  return { jobs: jobsSwept, cache: cacheSwept, idempotency: idempotencySwept };
}

export function startStoreSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    const result = sweepExpired();
    if (result.jobs || result.cache || result.idempotency) {
      console.log(`Store sweep evicted: ${result.jobs} jobs, ${result.cache} cache entries, ${result.idempotency} idempotency entries`);
    }
  }, config.storeSweepIntervalMs).unref();
}
