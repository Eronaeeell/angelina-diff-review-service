import { config } from "../config";

type Task = () => Promise<void>;

/**
 * Simple semaphore-bounded task runner. Pushing beyond the concurrency
 * limit queues the task rather than rejecting it -- satisfies "a queued
 * 5th job must not fail."
 */
export class ConcurrencyQueue {
  private readonly limit: number;
  private running = 0;
  private readonly pending: Task[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  push(task: Task): void {
    this.pending.push(task);
    this.drain();
  }

  private drain(): void {
    while (this.running < this.limit && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.running++;
      task()
        .catch((err) => {
          console.error("Unhandled job queue task error:", err);
        })
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
}

export const jobQueue = new ConcurrencyQueue(config.maxConcurrentJobs);
