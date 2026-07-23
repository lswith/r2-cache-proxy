import { describe, expect, it } from "vitest";
import { checkAuth, deriveKey } from "../src/index";

describe("deriveKey", () => {
  it("maps /host/path to an R2 key + https upstream", () => {
    expect(deriveKey(new URL("https://mirror/github.com/o/r/v1.tar.gz"))).toEqual({
      key: "github.com/o/r/v1.tar.gz",
      upstream: "https://github.com/o/r/v1.tar.gz",
    });
  });

  it("keeps the query string verbatim in both key and upstream", () => {
    expect(deriveKey(new URL("https://mirror/example.com/file?v=2&t=abc"))).toEqual({
      key: "example.com/file?v=2&t=abc",
      upstream: "https://example.com/file?v=2&t=abc",
    });
  });

  it("returns null for an empty path", () => {
    expect(deriveKey(new URL("https://mirror/"))).toBeNull();
  });

  it("returns null when the first segment isn't host-shaped (no dot)", () => {
    expect(deriveKey(new URL("https://mirror/nothost/x"))).toBeNull();
  });
});

describe("checkAuth", () => {
  const secret = "s3cr3t";
  const basic = (user: string, pass: string): string => "Basic " + btoa(`${user}:${pass}`);

  it("accepts the correct password with any username", () => {
    expect(checkAuth(basic("bazel", secret), secret)).toBe(true);
    expect(checkAuth(basic("anyone", secret), secret)).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(checkAuth(basic("bazel", "nope"), secret)).toBe(false);
  });

  it("rejects a missing or non-Basic header", () => {
    expect(checkAuth(null, secret)).toBe(false);
    expect(checkAuth("Bearer xyz", secret)).toBe(false);
  });

  it("rejects when the secret is unset (fail closed)", () => {
    expect(checkAuth(basic("bazel", ""), "")).toBe(false);
  });

  it("rejects a credential with no colon separator", () => {
    expect(checkAuth("Basic " + btoa("nocolon"), secret)).toBe(false);
  });
});
