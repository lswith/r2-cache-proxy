/**
 * Structured JSON (NDJSON) logger for Cloudflare Workers.
 *
 * Every line is a JSON object, which Cloudflare Workers Observability parses
 * and groups per invocation (see `observability.logs` in wrangler.jsonc). To
 * turn that pile of log lines into a proper "breadcrumb trail" for a given
 * run — the thing an error-tracking dashboard needs to trace an error back
 * to what led to it — every line emitted during an invocation is stamped
 * with a shared `requestId`/`route` via `withRequestContext` below. No
 * external SDK: just AsyncLocalStorage (available under the `nodejs_compat`
 * flag) propagating context across the async call graph.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  svc: string;
  [key: string]: unknown;
}

interface RequestContext {
  requestId: string;
  route?: string;
  [key: string]: unknown;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with a fresh request-scoped logging context. Call this once at
 * the top of `fetch`/`scheduled` so every log line emitted anywhere during
 * that invocation — including deep in a helper several `await`s down — is
 * automatically stamped with `requestId`/`route`.
 */
export function withRequestContext<T>(
  base: RequestContext,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return requestContext.run({ ...base }, fn);
}

function emit(level: LogLevel, svc: string, msg: string, fields?: Record<string, unknown>): void {
  const ctx = requestContext.getStore();
  const record: LogRecord = { ts: new Date().toISOString(), level, msg, svc, ...ctx, ...fields };
  const line = JSON.stringify(record);
  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "info":
      console.log(line);
      break;
    case "debug":
      console.debug(line);
      break;
  }
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  err(msg: string, err: unknown, fields?: Record<string, unknown>): void;
}

export function createLogger(svc: string): Logger {
  return {
    debug: (msg, fields) => emit("debug", svc, msg, fields),
    info: (msg, fields) => emit("info", svc, msg, fields),
    warn: (msg, fields) => emit("warn", svc, msg, fields),
    error: (msg, fields) => emit("error", svc, msg, fields),
    err(msg, err, extra) {
      const fields: Record<string, unknown> = { ...extra };
      if (err instanceof Error) {
        fields.err = err.message;
        fields.stack = err.stack;
      } else {
        fields.err = String(err);
      }
      emit("error", svc, msg, fields);
    },
  };
}
