import { config } from "../config";
import { parseUnifiedDiff } from "../diff/parser";
import { chunkFiles } from "../diff/chunker";
import { getProvider } from "../providers";
import { DiffFileBlock, Finding, Job } from "../types";
import { emitEvent } from "./store";

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return 0;
  });
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

function comparePath(a: DiffFileBlock, b: DiffFileBlock): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Wall-clock breakdown for one job, all measured from `createdAt` -- the
 * moment of submission, which is when the contract's 30s budget starts.
 * `queuedMs` is the part spent waiting for a worker slot: it is invisible
 * to any per-call timeout, so a job can blow the budget without a single
 * slow provider call.
 */
export function timingsFor(job: Job): { queuedMs: number; runningMs: number; totalMs: number } {
  const now = Date.now();
  const started = job.startedAt ?? now;
  const finished = job.finishedAt ?? now;
  return {
    queuedMs: started - job.createdAt,
    runningMs: Math.max(0, finished - started),
    totalMs: finished - job.createdAt,
  };
}

export async function processJob(job: Job): Promise<void> {
  job.status = "running";
  job.startedAt = Date.now();
  emitEvent(job, { event: "status", data: { status: "running" } });

  try {
    const parsed = parseUnifiedDiff(job.diff);
    if (!parsed) {
      throw new Error("diff failed to parse during processing");
    }

    // Sort files by path *before* chunking (chunking still only splits on
    // file boundaries). Because bin-packing then groups files in that order,
    // chunk N's paths are always <= chunk N+1's paths -- so once a chunk
    // resolves, its findings are already in final global order relative to
    // every other chunk and can be streamed immediately instead of waiting
    // for the whole scan.
    const sortedFiles = [...parsed.files].sort(comparePath);
    const chunks = chunkFiles(sortedFiles, config.chunkBytes);
    job.usage.chunks = chunks.length;

    const provider = getProvider(job.options.provider);

    // Deadline is anchored to submission (createdAt), not to now: whatever
    // the job spent queued is already gone from its 30s budget. Without
    // this, a job that waited 11.6s for a worker still handed the provider
    // a full 27s call and finished at 38.6s -- measured in production, not
    // hypothetical.
    const deadlineAt = job.createdAt + config.jobBudgetMs - config.jobBudgetSafetyMs;

    // Kick off every chunk's provider call concurrently (this is what lets
    // e.g. the llm provider process a multi-chunk diff in parallel instead
    // of paying the sum of each chunk's latency), but still await + emit
    // them in chunk order so streaming stays correctly ordered.
    const chunkPromises = chunks.map((chunkFileList) => {
      const pathsInChunk = new Set(chunkFileList.map((f) => f.path));
      const addedLines = parsed.addedLines.filter((l) => pathsInChunk.has(l.path));
      const lineRecordsByPath = new Map(
        [...parsed.lineRecordsByPath].filter(([path]) => pathsInChunk.has(path))
      );
      return provider
        .reviewChunk({ files: chunkFileList, addedLines, lineRecordsByPath, deadlineAt })
        .then((findings) => sortFindings(dedupe(findings)));
    });

    const allFindings: Finding[] = [];
    let emittedCount = 0;

    for (const chunkPromise of chunkPromises) {
      const chunkFindings = await chunkPromise;
      for (const finding of chunkFindings) {
        allFindings.push(finding);
        if (emittedCount < job.options.maxFindings) {
          emitEvent(job, { event: "finding", data: finding });
          emittedCount++;
        }
      }
    }

    // Defensive final pass: cheap, and guards against any provider that
    // somehow reports a finding out of the order this scheme assumes.
    const ordered = sortFindings(dedupe(allFindings));
    job.findings = ordered.slice(0, job.options.maxFindings);

    job.status = "done";
    job.finishedAt = Date.now();
    // `timings` rides on the status event, not the `done` event: the contract
    // pins `done` to exactly {total, usage}, so extra keys go where the shape
    // is ours to choose.
    emitEvent(job, { event: "status", data: { status: "done", timings: timingsFor(job) } });
    emitEvent(job, { event: "done", data: { total: job.findings.length, usage: job.usage } });
  } catch (err: any) {
    job.status = "failed";
    job.finishedAt = Date.now();
    job.error = { code: "internal", message: err?.message ?? "Unknown processing error" };
    emitEvent(job, { event: "status", data: { status: "failed", error: job.error, timings: timingsFor(job) } });
    emitEvent(job, { event: "done", data: { total: 0, usage: job.usage } });
  }
}
