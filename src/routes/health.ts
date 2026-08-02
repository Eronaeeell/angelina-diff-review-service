import { Router } from "express";
import { startedAt, VERSION } from "../config";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

export default router;
