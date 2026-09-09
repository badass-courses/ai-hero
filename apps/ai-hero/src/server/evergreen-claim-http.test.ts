import { describe, it, expect, vi } from "vitest";
import { createEvergreenClaimHttp } from "./evergreen-claim-http";

const origin = "https://example.test";
const url = `${origin}/api/evergreen-claim`;
function fixture(enabled = true) {
  const claim = vi.fn(async () => "pending" as const);
  const status = vi.fn(async () => "ready" as const);
  const now = new Date("2026-09-08T10:00:00.000Z");
  const lookup = vi.fn(async (token: string) =>
    token === "real-session"
      ? {
          session: {
            userId: "user-1",
            expires: new Date(now.getTime() + 600000),
          },
          user: { id: "user-1" },
        }
      : null,
  );
  const handler = createEvergreenClaimHttp({
    enabled,
    origin,
    productPath: "/products/course",
    secret: "test-only",
    getSessionAndUser: lookup,
    application: { claim, status },
    now: () => now,
  });
  const get = () =>
    handler(
      new Request(url, {
        headers: { cookie: "authjs.session-token=real-session" },
      }),
    );
  return { handler, claim, status, lookup, get, now };
}
describe("account-only claim HTTP boundary", () => {
  it("GET resolves a real session and never mutates", async () => {
    const f = fixture();
    expect((await (await f.get()).json()).status).toBe("ready");
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.lookup).toHaveBeenCalledWith("real-session");
  });
  it("accepts same-origin session-bound CSRF POST", async () => {
    const f = fixture();
    const { csrf } = await (await f.get()).json();
    const r = await f.handler(
      new Request(url, {
        method: "POST",
        headers: {
          origin,
          cookie: "authjs.session-token=real-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ csrf }),
      }),
    );
    expect(r.status).toBe(200);
    expect(f.claim).toHaveBeenCalledWith({
      userId: "user-1",
      sessionToken: "real-session",
    });
  });
  it("rejects expired CSRF even while the DB session remains current", async () => {
    const f = fixture();
    const { csrf } = await (await f.get()).json();
    f.now.setTime(f.now.getTime() + 300000);
    const response = await f.handler(
      new Request(url, {
        method: "POST",
        headers: {
          origin,
          cookie: "authjs.session-token=real-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ csrf }),
      }),
    );
    expect(response.status).toBe(403);
    expect(f.claim).not.toHaveBeenCalled();
  });
  it("rejects a different valid account session using the first account CSRF", async () => {
    const f = fixture();
    const { csrf } = await (await f.get()).json();
    f.lookup.mockResolvedValue({
      session: {
        userId: "other-user",
        expires: new Date(f.now.getTime() + 600000),
      },
      user: { id: "other-user" },
    });
    const response = await f.handler(
      new Request(url, {
        method: "POST",
        headers: {
          origin,
          cookie: "authjs.session-token=other-real-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ csrf }),
      }),
    );
    expect(response.status).toBe(403);
    expect(f.claim).not.toHaveBeenCalled();
  });
  it.each(["https://attacker.test", "null", ""])(
    "rejects origin %s",
    async (originHeader) => {
      const f = fixture();
      const r = await f.handler(
        new Request(url, {
          method: "POST",
          headers: { origin: originHeader },
          body: "{}",
        }),
      );
      expect(r.status).toBe(403);
      expect(f.claim).not.toHaveBeenCalled();
    },
  );
  it.each([
    { csrf: "fake" },
    { csrf: "fake", userId: "victim" },
    { returnTo: "https://attacker.test" },
    {},
  ])("rejects submitted selectors or forged csrf %j", async (body) => {
    const f = fixture();
    const r = await f.handler(
      new Request(url, {
        method: "POST",
        headers: {
          origin,
          cookie: "authjs.session-token=real-session",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(r.status).toBe(403);
    expect(f.claim).not.toHaveBeenCalled();
  });
  it("rejects forged session and URL selectors", async () => {
    const f = fixture();
    expect(
      (
        await f.handler(
          new Request(url, {
            headers: { cookie: "authjs.session-token=victim" },
          }),
        )
      ).status,
    ).toBe(401);
    expect((await f.handler(new Request(`${url}?userId=victim`))).status).toBe(
      400,
    );
    expect(f.claim).not.toHaveBeenCalled();
  });
  it("disabled never resolves sessions or invokes application", async () => {
    const f = fixture(false);
    expect((await f.get()).status).toBe(404);
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.status).not.toHaveBeenCalled();
  });
  it("duplicate/conflicting auth cookies fail closed", async () => {
    const f = fixture();
    expect(
      (
        await f.handler(
          new Request(url, {
            headers: {
              cookie:
                "authjs.session-token=real-session; __Secure-authjs.session-token=other",
            },
          }),
        )
      ).status,
    ).toBe(403);
    expect(f.lookup).not.toHaveBeenCalled();
  });
});
