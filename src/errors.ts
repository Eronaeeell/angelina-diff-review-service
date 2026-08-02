export type ErrorCode =
  | "unauthorized"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_diff"
  | "idempotency_conflict"
  | "not_found"
  | "rate_limited"
  | "internal";

export class AppError extends Error {
  code: ErrorCode;
  status: number;
  extraHeaders?: Record<string, string>;

  constructor(code: ErrorCode, status: number, message: string, extraHeaders?: Record<string, string>) {
    super(message);
    this.code = code;
    this.status = status;
    this.extraHeaders = extraHeaders;
  }
}

export function errorEnvelope(code: ErrorCode, message: string) {
  return { error: { code, message } };
}

export const Errors = {
  unauthorized: (msg = "Missing or invalid bearer token") => new AppError("unauthorized", 401, msg),
  payloadTooLarge: (msg = "Payload exceeds maximum allowed size") => new AppError("payload_too_large", 413, msg),
  invalidJson: (msg = "Request body is not valid JSON") => new AppError("invalid_json", 400, msg),
  invalidDiff: (msg = "diff is missing, empty, or not a parseable unified diff") => new AppError("invalid_diff", 422, msg),
  idempotencyConflict: (msg = "Idempotency-Key was already used with a different request body") =>
    new AppError("idempotency_conflict", 409, msg),
  notFound: (msg = "No job with that id") => new AppError("not_found", 404, msg),
  rateLimited: (retryAfterSeconds: number, msg = "Rate limit exceeded") =>
    new AppError("rate_limited", 429, msg, { "Retry-After": String(retryAfterSeconds) }),
  internal: (msg = "Internal error") => new AppError("internal", 500, msg),
};
