export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "security" | "correctness" | "performance" | "style";

export interface Finding {
  id: string;
  ruleId: string;
  path: string;
  line: number;
  severity: Severity;
  category: Category;
  title: string;
  evidence: string;
}

export type ProviderName = "mock" | "llm";

export interface ReviewOptions {
  provider: ProviderName;
  maxFindings: number;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Usage {
  inputBytes: number;
  chunks: number;
  cacheHit: boolean;
}

export interface JobError {
  code: string;
  message: string;
}

export interface StreamEvent {
  event: "status" | "finding" | "done";
  data: unknown;
}

export interface Job {
  jobId: string;
  status: JobStatus;
  diff: string;
  options: ReviewOptions;
  findings: Finding[];
  usage: Usage;
  error?: JobError;
  events: StreamEvent[];
  /** Submission time -- the moment the 30s budget starts counting. */
  createdAt: number;
  /** When a worker picked the job up. The gap from createdAt is queue wait. */
  startedAt?: number;
  /** When the job reached a terminal state (done or failed). */
  finishedAt?: number;
  contentHash: string;
  waiters: Array<(ev: StreamEvent) => void>;
}

export interface DiffFileBlock {
  path: string;
  raw: string;
  bytes: number;
}

export interface ParsedAddedLine {
  path: string;
  line: number;
  text: string;
}

export interface LineRecord {
  marker: "added" | "context";
  line: number;
  text: string;
}
