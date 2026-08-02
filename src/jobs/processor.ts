import { config } from "../config";
import { parseUnifiedDiff } from "../diff/parser";
import { chunkFiles } from "../diff/chunker";
import { getProvider } from "../providers";
import { Finding, Job } from "../types";
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

export async function processJob(job: Job): Promise<void> {
  job.status = "running";
  emitEvent(job, { event: "status", data: { status: "running" } });

  try {
    const parsed = parseUnifiedDiff(job.diff);
    if (!parsed) {
      throw new Error("diff failed to parse during processing");
    }

    const chunks = chunkFiles(parsed.files, config.chunkBytes);
    job.usage.chunks = chunks.length;

    const provider = getProvider(job.options.provider);
    const allFindings: Finding[] = [];

    for (const chunkFileList of chunks) {
      const pathsInChunk = new Set(chunkFileList.map((f) => f.path));
      const addedLines = parsed.addedLines.filter((l) => pathsInChunk.has(l.path));
      const lineRecordsByPath = new Map(
        [...parsed.lineRecordsByPath].filter(([path]) => pathsInChunk.has(path))
      );

      const chunkFindings = await provider.reviewChunk({
        files: chunkFileList,
        addedLines,
        lineRecordsByPath,
      });
      allFindings.push(...chunkFindings);
    }

    const ordered = sortFindings(dedupe(allFindings));
    job.findings = ordered.slice(0, job.options.maxFindings);

    for (const finding of job.findings) {
      emitEvent(job, { event: "finding", data: finding });
    }
    job.status = "done";
    emitEvent(job, { event: "status", data: { status: "done" } });
    emitEvent(job, { event: "done", data: { total: job.findings.length, usage: job.usage } });
  } catch (err: any) {
    job.status = "failed";
    job.error = { code: "internal", message: err?.message ?? "Unknown processing error" };
    emitEvent(job, { event: "status", data: { status: "failed", error: job.error } });
    emitEvent(job, { event: "done", data: { total: 0, usage: job.usage } });
  }
}
