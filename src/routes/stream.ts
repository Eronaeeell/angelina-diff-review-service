import { Request, Response, Router } from "express";
import { errorEnvelope } from "../errors";
import { getJob, subscribe } from "../jobs/store";
import { StreamEvent } from "../types";

const router = Router();

router.get("/v1/reviews/:jobId/stream", (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json(errorEnvelope("not_found", "No job with that id"));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const write = (ev: StreamEvent): void => {
    res.write(`event: ${ev.event}\n`);
    res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
  };

  // Replay history first so a client connecting mid-processing (or after
  // completion) still sees every event that already happened.
  for (const ev of job.events) write(ev);

  const alreadyFinished = job.status === "done" || job.status === "failed";
  if (alreadyFinished) {
    res.end();
    return;
  }

  const unsubscribe = subscribe(job, (ev) => {
    write(ev);
    if (ev.event === "done") {
      unsubscribe();
      res.end();
    }
  });

  req.on("close", () => {
    unsubscribe();
  });
});

export default router;
