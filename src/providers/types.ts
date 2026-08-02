import { DiffFileBlock, Finding, LineRecord, ParsedAddedLine, ProviderName } from "../types";

export interface ChunkInput {
  files: DiffFileBlock[];
  addedLines: ParsedAddedLine[];
  lineRecordsByPath: Map<string, LineRecord[]>;
  /**
   * Absolute epoch-ms deadline for this chunk, derived from the job's
   * *submission* time -- not from when a worker picked it up. The contract's
   * 30s budget starts when the client POSTs, so time spent queued behind
   * other jobs has already been spent. A provider that ignores this and
   * applies its own fixed timeout will blow the budget under concurrency:
   * measured 11.6s queued + a full 27s call = a 38.6s job.
   */
  deadlineAt: number;
}

export interface Provider {
  name: ProviderName;
  reviewChunk(input: ChunkInput): Promise<Finding[]>;
}
