import express, { Express } from "express";
import { config } from "./config";
import { Errors } from "./errors";
import { authMiddleware } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";
import healthRouter from "./routes/health";
import specRouter from "./routes/spec";
import reviewsRouter from "./routes/reviews";
import streamRouter from "./routes/stream";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(
    express.json({
      limit: config.maxPayloadBytes,
      type: () => true,
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    })
  );

  // Public routes -- no auth required.
  app.use(healthRouter);
  app.use(specRouter);

  // Everything under /v1/* requires a valid bearer token.
  app.use("/v1", authMiddleware);
  app.use(reviewsRouter);
  app.use(streamRouter);

  // Anything unmatched gets the error envelope rather than Express's default
  // HTML 404 page, so every non-2xx response on this service has one shape.
  app.use((_req, _res, next) => next(Errors.notFound("No such route")));

  app.use(errorHandler);

  return app;
}
