import { describe, expect, it } from "vitest";
import { apiOrigin, forwardedOrigin } from "../scripts/dev-proxy";

describe("development proxy origin protection", () => {
  it("translates same-origin requests from either local frontend hostname", () => {
    expect(forwardedOrigin("http://127.0.0.1:5173", "127.0.0.1:5173")).toBe(
      apiOrigin,
    );
    expect(forwardedOrigin("http://localhost:5173", "localhost:5173")).toBe(
      apiOrigin,
    );
  });

  it("preserves foreign, null, mismatched-port and mismatched-scheme origins", () => {
    for (const origin of [
      "https://attacker.example",
      "null",
      "http://127.0.0.1:4000",
      "https://127.0.0.1:5173",
    ]) {
      expect(forwardedOrigin(origin, "127.0.0.1:5173")).toBe(origin);
    }
  });

  it("does not invent a trusted origin for missing headers", () => {
    expect(forwardedOrigin(undefined, "127.0.0.1:5173")).toBe(undefined);
    expect(forwardedOrigin("http://localhost:5173", undefined)).toBe(
      "http://localhost:5173",
    );
  });
});
