import { describe, expect, it, vi } from "vitest";
import {
  createKitCommunicationTransport,
  KitCommunicationUnavailable,
} from "./kit-communication-transport";
import { createKitCurrentCommunicationReader } from "./current-authority";
import { emailPreferenceDefinitionByKey } from "@/coursebuilder/email-preferences";
import { AI_HERO_UNSUBSCRIBED_TAG_ID } from "../ai-hero-email-opt-in";

const at = new Date("2026-09-07T20:00:00.000Z");
const subscriber = {
  id: 123,
  first_name: null,
  email_address: "student@example.com",
  state: "active",
  created_at: at.toISOString(),
  fields: { pref_newsletter: null },
  canceled_at: null,
};
const page = {
  tags: [{ id: 42, name: "Synthetic tag", tagged_at: at.toISOString() }],
  pagination: {
    has_previous_page: false,
    has_next_page: false,
    start_cursor: "first",
    end_cursor: "last",
    per_page: 100,
  },
};
function response(
  body: unknown,
  url: string,
  options: {
    status?: number;
    text?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const result = new Response(options.text ?? JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
  });
  Object.defineProperties(result, {
    url: { value: url, configurable: true },
    type: { value: "basic", configurable: true },
  });
  return result;
}
function fixture(
  options: { apiKey?: string; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const http = vi.fn(
    async (url: string, _init: RequestInit): Promise<Response> =>
      response(url.includes("/tags") ? page : { subscriber }, url),
  );
  const now = vi.fn(() => at);
  const transport = createKitCommunicationTransport({
    apiKey: "test-only-placeholder",
    fetch: http,
    now,
    ...options,
  });
  return { http, now, transport };
}
const request = { subscriberId: "123", after: null, limit: 100 } as const;

describe("Kit communication GET transport", () => {
  it("uses fixed GET/auth/no-cache/redirect policy and returns raw inner subscriber with JSON null", async () => {
    const f = fixture();
    expect(await f.transport.getSubscriber("123")).toEqual(subscriber);
    const [url, init] = f.http.mock.calls[0]!;
    expect(url).toBe("https://api.kit.com/v4/subscribers/123");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
    expect(new Headers(init.headers).get("X-Kit-Api-Key")).toBe(
      "test-only-placeholder",
    );
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("normalizes a valid final page with NONNULL end_cursor to nextCursor:null", async () => {
    const f = fixture();
    const result = await f.transport.getSubscriberTagsPage(request);
    expect(result).toEqual({
      subscriberId: "123",
      after: null,
      tags: [{ id: 42 }],
      readStartedAt: at.toISOString(),
      readAt: at.toISOString(),
      truncated: false,
      pagination: { hasNextPage: false, nextCursor: null },
    });
    expect(f.http.mock.calls[0]![0]).toBe(
      "https://api.kit.com/v4/subscribers/123/tags?per_page=100",
    );
  });
  it("encodes cursor as data, binds request identity/cursor, and preserves continuation", async () => {
    const f = fixture();
    f.http.mockImplementation(async (url) =>
      response(
        {
          ...page,
          pagination: {
            ...page.pagination,
            has_next_page: true,
            end_cursor: "next+/=",
          },
        },
        url,
      ),
    );
    const after = "cursor+/=&subscriber_id=999";
    const result = await f.transport.getSubscriberTagsPage({
      ...request,
      after,
    });
    const url = new URL(f.http.mock.calls[0]![0]);
    expect(url.searchParams.get("after")).toBe(after);
    expect(url.searchParams.has("subscriber_id")).toBe(false);
    expect(result).toMatchObject({
      subscriberId: "123",
      after,
      pagination: { hasNextPage: true, nextCursor: "next+/=" },
    });
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it.each(["", "0", "0123", "../999", "123?x=1", "9007199254740992"])(
    "rejects noncanonical identity %s before HTTP",
    async (id) => {
      const f = fixture();
      await expect(f.transport.getSubscriber(id)).rejects.toBeInstanceOf(
        KitCommunicationUnavailable,
      );
      expect(f.http).not.toHaveBeenCalled();
    },
  );
  it.each(["", " ", "bad\r\nheader"])(
    "holds missing/invalid credentials",
    async (apiKey) => {
      const f = fixture({ apiKey });
      await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
        KitCommunicationUnavailable,
      );
      expect(f.http).not.toHaveBeenCalled();
    },
  );
  it.each([
    { subscriber: { ...subscriber, id: 999 } },
    { subscriber, id: 999 },
    { ok: true, result: { response: { subscriber } } },
    subscriber,
    { subscriber: { ...subscriber, fields: null } },
    { subscriber: { ...subscriber, state: undefined } },
  ])(
    "holds mismatched or malformed HTTP subscriber envelope %#",
    async (body) => {
      const f = fixture();
      f.http.mockImplementation(async (url) => response(body, url));
      await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
        KitCommunicationUnavailable,
      );
    },
  );
  it.each([401, 429, 500, 206, 302])(
    "holds HTTP %s without retries",
    async (status) => {
      const f = fixture();
      f.http.mockImplementation(async (url) =>
        response({ subscriber }, url, { status }),
      );
      await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
        KitCommunicationUnavailable,
      );
      expect(f.http).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["off-origin", "wrong-id", "redirected", "opaque", "missing-url"])(
    "rejects %s response binding",
    async (mode) => {
      const f = fixture();
      f.http.mockImplementation(async (url) => {
        const r = response({ subscriber }, url);
        if (mode === "redirected")
          Object.defineProperty(r, "redirected", { value: true });
        else if (mode === "opaque")
          Object.defineProperty(r, "type", { value: "opaque" });
        else
          Object.defineProperty(r, "url", {
            value:
              mode === "off-origin"
                ? "https://other.example/subscribers/123"
                : mode === "wrong-id"
                  ? "https://api.kit.com/v4/subscribers/999"
                  : "",
          });
        return r;
      });
      await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
        KitCommunicationUnavailable,
      );
    },
  );
  it.each(["invalid-json", "truncated-json", "oversized", "length-mismatch"])(
    "holds %s bodies",
    async (mode) => {
      const f = fixture();
      f.http.mockImplementation(async (url) =>
        response({ subscriber }, url, {
          text:
            mode === "invalid-json"
              ? "not-json"
              : mode === "truncated-json"
                ? '{"subscriber":'
                : mode === "oversized"
                  ? " ".repeat(131073)
                  : undefined,
          headers:
            mode === "length-mismatch"
              ? { "content-length": "99999" }
              : undefined,
        }),
      );
      await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
        KitCommunicationUnavailable,
      );
    },
  );
  it.each([
    { tags: [], pagination: { has_next_page: true, end_cursor: null } },
    { tags: [], pagination: { end_cursor: "x" } },
    { tags: [], pagination: { has_next_page: false } },
    { tags: { entries: [], truncated: false }, pagination: page.pagination },
    {
      tags: Array.from({ length: 101 }, () => ({ id: 42 })),
      pagination: page.pagination,
    },
    { ok: true, result: { response: page } },
  ])("holds incomplete/CLI/oversized tag envelopes %#", async (body) => {
    const f = fixture();
    f.http.mockImplementation(async (url) => response(body, url));
    await expect(
      f.transport.getSubscriberTagsPage(request),
    ).rejects.toBeInstanceOf(KitCommunicationUnavailable);
  });
  it("timestamps around request and full decode with the shared clock", async () => {
    const f = fixture();
    f.now
      .mockReturnValueOnce(at)
      .mockReturnValueOnce(new Date(at.getTime() + 25));
    const result = await f.transport.getSubscriberTagsPage(request);
    expect(result.readStartedAt).toBe(at.toISOString());
    expect(result.readAt).toBe("2026-09-07T20:00:00.025Z");
  });
  it("holds clock failure and reversed intervals", async () => {
    const f = fixture();
    f.now
      .mockReturnValueOnce(at)
      .mockReturnValueOnce(new Date(at.getTime() - 1));
    await expect(
      f.transport.getSubscriberTagsPage(request),
    ).rejects.toBeInstanceOf(KitCommunicationUnavailable);
    f.now.mockImplementation(() => {
      throw new Error("private clock error");
    });
    await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
      KitCommunicationUnavailable,
    );
  });
  it.each(["headers", "body"])(
    "bounds %s timeout even when mocked HTTP does not cooperate",
    async (mode) => {
      const f = fixture({ timeoutMs: 10 });
      let cancelled = false;
      f.http.mockImplementation(async (url) => {
        if (mode === "headers") return new Promise<Response>(() => {});
        const r = new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
        Object.defineProperties(r, {
          url: { value: url },
          type: { value: "basic" },
        });
        return r;
      });
      await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
        KitCommunicationUnavailable,
      );
      if (mode === "body") expect(cancelled).toBe(true);
    },
  );
  it("fails closed on caller cancellation without exposing the abort reason", async () => {
    const controller = new AbortController();
    controller.abort("private abort detail");
    const f = fixture({ signal: controller.signal });
    await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
      KitCommunicationUnavailable,
    );
    expect(f.http).not.toHaveBeenCalled();
  });
  it("does not expose credential, body, identity, URL or underlying error in failures", async () => {
    const f = fixture();
    f.http.mockRejectedValue(
      new Error(
        "test-only-placeholder student@example.com https://api.kit.com/v4/subscribers/123 private-body",
      ),
    );
    const error = await f.transport
      .getSubscriber("123")
      .catch((value) => value);
    expect(error).toBeInstanceOf(KitCommunicationUnavailable);
    for (const secret of [
      "test-only-placeholder",
      "student@example.com",
      "https://",
      "private-body",
    ])
      expect(JSON.stringify(error) + String(error)).not.toContain(secret);
  });
  it("rejects a response replayed from a different tag cursor", async () => {
    const f = fixture();
    f.http.mockImplementation(async (url) =>
      response(page, url + "&after=other"),
    );
    await expect(
      f.transport.getSubscriberTagsPage(request),
    ).rejects.toBeInstanceOf(KitCommunicationUnavailable);
  });
  it("accepts a complete empty tag page with null end_cursor", async () => {
    const f = fixture();
    f.http.mockImplementation(async (url) =>
      response(
        {
          ...page,
          tags: [],
          pagination: { ...page.pagination, end_cursor: null },
        },
        url,
      ),
    );
    expect(
      (await f.transport.getSubscriberTagsPage(request)).pagination,
    ).toEqual({ hasNextPage: false, nextCursor: null });
  });
  it("preserves unknown provider state for the owning reader to hold, not default", async () => {
    const f = fixture();
    f.http.mockImplementation(async (url) =>
      response({ subscriber: { ...subscriber, state: "future-state" } }, url),
    );
    expect((await f.transport.getSubscriber("123")).state).toBe("future-state");
  });
  it("does not compare decompressed bytes with compressed Content-Length", async () => {
    const f = fixture();
    f.http.mockImplementation(async (url) =>
      response({ subscriber }, url, {
        headers: { "content-encoding": "gzip", "content-length": "12" },
      }),
    );
    expect((await f.transport.getSubscriber("123")).id).toBe(123);
  });
  it("cancels a rejected response body without reading it", async () => {
    const f = fixture();
    let cancelled = false;
    f.http.mockImplementation(async (url) => {
      const r = new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      Object.defineProperties(r, {
        url: { value: url },
        type: { value: "basic" },
      });
      return r;
    });
    await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
      KitCommunicationUnavailable,
    );
    expect(cancelled).toBe(true);
  });
  it("cancels an in-flight request with a fixed failure", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    let notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    f.http.mockImplementation(async () => {
      notify();
      return new Promise<Response>(() => {});
    });
    const pending = expect(
      f.transport.getSubscriber("123"),
    ).rejects.toBeInstanceOf(KitCommunicationUnavailable);
    await started;
    controller.abort("private reason");
    await pending;
  });
  it.each([0, 30001, NaN])(
    "rejects invalid timeout %s before HTTP",
    async (timeoutMs) => {
      const f = fixture({ timeoutMs });
      await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
        KitCommunicationUnavailable,
      );
      expect(f.http).not.toHaveBeenCalled();
    },
  );
  it.each([true, undefined, null, "false"])(
    "cannot establish absence from initial previous-page evidence %s",
    async (hasPrevious) => {
      const f = fixture();
      f.http.mockImplementation(async (url) =>
        response(
          url.includes("/tags")
            ? {
                tags: [],
                pagination: {
                  has_previous_page: hasPrevious,
                  has_next_page: false,
                  start_cursor: "later-page",
                  end_cursor: "last-page",
                  per_page: 100,
                },
              }
            : { subscriber },
          url,
        ),
      );
      const reader = createKitCurrentCommunicationReader({
        ...f.transport,
        now: f.now,
        preference: emailPreferenceDefinitionByKey.newsletter,
        exclusionTagId: AI_HERO_UNSUBSCRIBED_TAG_ID,
      });
      await expect(
        reader.read({ subscriberId: "123", email: "student@example.com" }),
      ).rejects.toBeInstanceOf(KitCommunicationUnavailable);
      expect(f.http.mock.calls.map(([url]) => url)).toEqual([
        "https://api.kit.com/v4/subscribers/123",
        "https://api.kit.com/v4/subscribers/123/tags?per_page=100",
      ]);
    },
  );
  it("preserves continuation with previous pages and a valid terminal nonnull cursor", async () => {
    const f = fixture();
    f.http.mockImplementation(async (url) =>
      response(
        {
          ...page,
          pagination: {
            ...page.pagination,
            has_previous_page: true,
            has_next_page: false,
            end_cursor: "last",
          },
        },
        url,
      ),
    );
    const result = await f.transport.getSubscriberTagsPage({
      ...request,
      after: "prior",
    });
    expect(result).toMatchObject({
      after: "prior",
      truncated: false,
      pagination: { hasNextPage: false, nextCursor: null },
    });
  });
  it.each(["131073", "not-a-length"])(
    "cancels an OPEN body rejected by Content-Length %s",
    async (length) => {
      const f = fixture();
      let cancelled = 0;
      f.http.mockImplementation(async (url) => {
        const r = new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "content-length": length,
            },
          },
        );
        Object.defineProperties(r, {
          url: { value: url },
          type: { value: "basic" },
        });
        return r;
      });
      await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
        KitCommunicationUnavailable,
      );
      expect(cancelled).toBe(1);
    },
  );
  it("disposes an open response arriving after the request deadline", async () => {
    const f = fixture({ timeoutMs: 10 });
    let finish!: (response: Response) => void;
    let requested = "";
    let cancelled = 0;
    f.http.mockImplementation(async (url) => {
      requested = url;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    await expect(f.transport.getSubscriber("123")).rejects.toBeInstanceOf(
      KitCommunicationUnavailable,
    );
    const late = new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    Object.defineProperties(late, {
      url: { value: requested },
      type: { value: "basic" },
    });
    finish(late);
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(1);
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it.each(["clear", "excluded", "incomplete"])(
    "composes with unchanged authority reader: %s",
    async (mode) => {
      const f = fixture();
      f.http.mockImplementation(async (url) =>
        response(
          url.includes("/tags")
            ? {
                ...page,
                tags:
                  mode === "excluded"
                    ? [{ id: Number(AI_HERO_UNSUBSCRIBED_TAG_ID) }]
                    : [],
                pagination: mode === "incomplete" ? {} : page.pagination,
              }
            : { subscriber },
          url,
        ),
      );
      const reader = createKitCurrentCommunicationReader({
        ...f.transport,
        now: f.now,
        preference: emailPreferenceDefinitionByKey.newsletter,
        exclusionTagId: AI_HERO_UNSUBSCRIBED_TAG_ID,
      });
      const promise = reader.read({
        subscriberId: "123",
        email: "student@example.com",
      });
      if (mode === "incomplete")
        await expect(promise).rejects.toBeInstanceOf(
          KitCommunicationUnavailable,
        );
      else
        expect((await promise).delivery.type).toBe(
          mode === "clear" ? "Eligible" : "Unsubscribed",
        );
    },
  );
});
