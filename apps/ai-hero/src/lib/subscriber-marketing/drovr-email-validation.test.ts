import { afterEach, describe, expect, it, vi } from "vitest";
import { validateEmailWithDrovr } from "./drovr-email-validation";

const email = "person@example.test";
const config = { baseUrl: "https://drovr.example.test/", apiKey: "test-key" };
afterEach(() => {
  vi.useRealTimers();
});

describe("validateEmailWithDrovr", () => {
  it("accepts and sends the agreed request without returning the address", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        verdict: "accept",
        email,
        policyVersion: "test-policy",
      }),
    );
    expect(await validateEmailWithDrovr(email, { ...config, fetch })).toEqual({
      verdict: "accept",
      policyVersion: "test-policy",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://drovr.example.test/email-validations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-key" }),
        body: JSON.stringify({ email }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it("returns a rejection reason and suggestion", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        verdict: "reject",
        email,
        reason: "disposable_domain",
        suggestion: "person@other.example.test",
        policyVersion: "test-policy",
      }),
    );
    expect(await validateEmailWithDrovr(email, { ...config, fetch })).toEqual({
      verdict: "reject",
      reason: "disposable_domain",
      suggestion: "person@other.example.test",
      policyVersion: "test-policy",
    });
  });
  it("fails open on 500", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    expect(await validateEmailWithDrovr(email, { ...config, fetch })).toEqual({
      verdict: "unknown",
      error: "http_error",
      httpStatus: 500,
    });
  });
  it.each([
    ["invalid-json", "bad_body"],
    ["invalid-shape", "bad_body"],
    ["network", "request_failed"],
  ])("fails open on %s with %s", async (failure, error) => {
    const fetch = vi.fn().mockImplementation(async () => {
      if (failure === "network") throw new Error("private request details");
      return failure === "invalid-json"
        ? new Response("no")
        : Response.json({ verdict: "reject" });
    });
    const result = await validateEmailWithDrovr(email, { ...config, fetch });
    expect(result).toEqual({ verdict: "unknown", error });
    expect(JSON.stringify(result)).not.toContain("private request details");
  });
  it("times out after 800 ms and aborts, even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    const result = validateEmailWithDrovr(email, { ...config, fetch });
    await vi.advanceTimersByTimeAsync(800);
    expect(await result).toEqual({ verdict: "unknown", error: "timeout" });
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    undefined,
    {},
    { baseUrl: config.baseUrl },
    { apiKey: config.apiKey },
  ])("skips missing config %j", async (partial) => {
    const fetch = vi.fn();
    expect(await validateEmailWithDrovr(email, { ...partial, fetch })).toEqual({
      verdict: "unknown",
      error: "missing_config",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
