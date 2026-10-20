import { describe, expect, it } from "vitest";

import {
  getNextAuthErrorLogLevel,
  getSafeAuthErrorLogData,
} from "./auth-log-policy";

describe("auth log policy", () => {
  it("keeps generic AccessDenied wrappers actionable", () => {
    expect(getNextAuthErrorLogLevel({ type: "AccessDenied" })).toBe("error");
    expect(getNextAuthErrorLogLevel({ name: "AccessDenied" })).toBe("error");
  });

  it("keeps actionable OAuth callback failures at error level", () => {
    expect(getNextAuthErrorLogLevel({ type: "OAuthCallbackError" })).toBe(
      "error",
    );
  });

  it.each([
    ["Verification", "verification"],
    ["Configuration", "configuration"],
    ["MissingCSRF", "missing-csrf"],
    ["InvalidCheck", "invalid-check"],
    ["EmailSignInError", "email-sign-in-failed"],
    ["CallbackRouteError", "callback-route-failed"],
    ["SessionTokenError", "session-token-error"],
    ["JWTSessionError", "jwt-session-error"],
    ["UnknownAction", "unknown-action"],
    ["InvalidCallbackUrl", "invalid-callback-url"],
    ["UntrustedHost", "untrusted-host"],
  ])("records %s with a stable reason code", (type, reasonCode) => {
    expect(getSafeAuthErrorLogData({ type })).toMatchObject({
      errorType: type,
      reasonCode,
    });
  });

  it("keeps existing reason codes", () => {
    expect(getSafeAuthErrorLogData({ type: "AccessDenied" }).reasonCode).toBe(
      "access-denied",
    );
    expect(getSafeAuthErrorLogData({ name: "AdapterError" }).reasonCode).toBe(
      "adapter-failed",
    );
  });

  it("collapses unrecognised names to unknown", () => {
    expect(getSafeAuthErrorLogData({ type: "jane@example.com" })).toEqual({
      errorType: "unknown",
      causeType: "unknown",
      reasonCode: "auth-failed",
    });
    expect(getSafeAuthErrorLogData(undefined).errorType).toBe("unknown");
  });

  it("records the allowlisted cause type from cause or cause.err", () => {
    expect(
      getSafeAuthErrorLogData({
        type: "CallbackRouteError",
        cause: { err: { type: "Verification" }, provider: "email" },
      }),
    ).toMatchObject({
      errorType: "CallbackRouteError",
      causeType: "Verification",
    });
    expect(
      getSafeAuthErrorLogData({
        type: "CallbackRouteError",
        cause: { name: "AdapterError" },
      }).causeType,
    ).toBe("AdapterError");
  });

  it("never leaks cause messages, emails or tokens", () => {
    const out = JSON.stringify(
      getSafeAuthErrorLogData({
        type: "CallbackRouteError",
        message: "token=abc123 for jane@example.com",
        cause: {
          err: new Error("jane@example.com token=abc123 https://x.test/?t=1"),
          message: "jane@example.com",
          name: "jane@example.com",
        },
      }),
    );
    expect(out).not.toMatch(/jane|abc123|example|https/);
    expect(JSON.parse(out).causeType).toBe("unknown");
  });
});
