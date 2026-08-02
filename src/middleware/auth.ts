import { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { Errors } from "../errors";

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1];

  if (!token || !config.bearerToken || token !== config.bearerToken) {
    next(Errors.unauthorized());
    return;
  }
  next();
}
