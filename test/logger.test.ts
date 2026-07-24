import { describe, expect, it } from "vitest";
import { createLogger, withRequestContext } from "../src/logger";

const svc = "r2-cache-proxy-test";

function captureConsole(fn: () => void): {
  log: string[];
  warn: string[];
  error: string[];
  debug: string[];
} {
  const out = {
    log: [] as string[],
    warn: [] as string[],
    error: [] as string[],
    debug: [] as string[],
  };
  const orig = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  console.log = (line: string) => out.log.push(line);
  console.warn = (line: string) => out.warn.push(line);
  console.error = (line: string) => out.error.push(line);
  console.debug = (line: string) => out.debug.push(line);
  try {
    fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    console.debug = orig.debug;
  }
  return out;
}

function parseLog(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("Logger", () => {
  it("emits info-level JSON with correct shape", () => {
    const out = captureConsole(() => {
      const log = createLogger(svc);
      log.info("cached upstream object", { key: "github.com/o/r/x.tar.gz" });
    });

    expect(out.log).toHaveLength(1);
    const rec = parseLog(out.log[0]);
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("cached upstream object");
    expect(rec.svc).toBe(svc);
    expect(rec.key).toBe("github.com/o/r/x.tar.gz");
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("emits warn-level JSON to console.warn", () => {
    const out = captureConsole(() => {
      const log = createLogger(svc);
      log.warn("upstream non-ok, passing through uncached", { status: 404 });
    });

    expect(out.warn).toHaveLength(1);
    const rec = parseLog(out.warn[0]);
    expect(rec.level).toBe("warn");
    expect(rec.msg).toBe("upstream non-ok, passing through uncached");
    expect(rec.status).toBe(404);
  });

  it("emits error-level JSON to console.error", () => {
    const out = captureConsole(() => {
      const log = createLogger(svc);
      log.error("object missing immediately after put", { key: "example.com/blob" });
    });

    expect(out.error).toHaveLength(1);
    const rec = parseLog(out.error[0]);
    expect(rec.level).toBe("error");
    expect(rec.msg).toBe("object missing immediately after put");
    expect(rec.key).toBe("example.com/blob");
  });

  it("emits debug-level JSON to console.debug", () => {
    const out = captureConsole(() => {
      const log = createLogger(svc);
      log.debug("candidate check", { fresh: true });
    });

    expect(out.debug).toHaveLength(1);
    const rec = parseLog(out.debug[0]);
    expect(rec.level).toBe("debug");
  });

  it(".err() captures error message and stack", () => {
    const out = captureConsole(() => {
      const log = createLogger(svc);
      log.err("upstream fetch failed", new Error("network boom"), { key: "abc" });
    });

    expect(out.error).toHaveLength(1);
    const rec = parseLog(out.error[0]);
    expect(rec.level).toBe("error");
    expect(rec.msg).toBe("upstream fetch failed");
    expect(rec.key).toBe("abc");
    expect(rec.err).toBe("network boom");
    expect(typeof rec.stack).toBe("string");
    expect((rec.stack as string).includes("network boom")).toBe(true);
  });

  it(".err() handles non-Error throwables", () => {
    const out = captureConsole(() => {
      const log = createLogger(svc);
      log.err("something broke", "plain string error");
    });

    expect(out.error).toHaveLength(1);
    const rec = parseLog(out.error[0]);
    expect(rec.err).toBe("plain string error");
    expect(rec.stack).toBeUndefined();
  });

  it("stamps log lines with the request context set by withRequestContext", async () => {
    const out = captureConsole(() => {});
    await withRequestContext({ requestId: "req-1", route: "/github.com/o/r/x.tar.gz" }, () => {
      Object.assign(
        out,
        captureConsole(() => {
          createLogger(svc).info("run done");
        }),
      );
    });

    const rec = parseLog(out.log[0]);
    expect(rec.requestId).toBe("req-1");
    expect(rec.route).toBe("/github.com/o/r/x.tar.gz");
  });

  it("each logger instance is independent by svc", () => {
    const out = captureConsole(() => {
      const a = createLogger("worker-a");
      const b = createLogger("worker-b");
      a.info("hello from a");
      b.info("hello from b");
    });

    expect(out.log).toHaveLength(2);
    const a = parseLog(out.log[0]);
    const b = parseLog(out.log[1]);
    expect(a.svc).toBe("worker-a");
    expect(b.svc).toBe("worker-b");
  });

  it("no fields param is fine", () => {
    const out = captureConsole(() => {
      createLogger("test").info("just a message");
    });

    const rec = parseLog(out.log[0]);
    expect(rec.msg).toBe("just a message");
    expect(Object.keys(rec).sort()).toEqual(["level", "msg", "svc", "ts"].sort());
  });
});
