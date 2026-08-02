import { NextFunction, Request, Response } from "express";
import { AppError, errorEnvelope } from "../errors";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    if (err.extraHeaders) {
      for (const [key, value] of Object.entries(err.extraHeaders)) res.setHeader(key, value);
    }
    res.status(err.status).json(errorEnvelope(err.code, err.message));
    return;
  }

  const anyErr = err as any;

  // body-parser throws these for oversized / malformed bodies.
  if (anyErr?.type === "entity.too.large" || anyErr?.status === 413) {
    res.status(413).json(errorEnvelope("payload_too_large", "Payload exceeds maximum allowed size"));
    return;
  }
  if (err instanceof SyntaxError || anyErr?.type === "entity.parse.failed") {
    res.status(400).json(errorEnvelope("invalid_json", "Request body is not valid JSON"));
    return;
  }

  console.error(err);
  res.status(500).json(errorEnvelope("internal", "Internal error"));
}
