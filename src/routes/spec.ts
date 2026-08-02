import { Router } from "express";
import { config } from "../config";

const router = Router();

router.get("/spec", (_req, res) => {
  res.status(200).json({
    specVersion: "1.0",
    providers: ["mock", "llm"],
    limits: {
      maxPayloadBytes: config.maxPayloadBytes,
      chunkBytes: config.chunkBytes,
      maxConcurrentJobs: config.maxConcurrentJobs,
      rateLimitPerMinute: config.rateLimitPerMinute,
    },
  });
});

export default router;
