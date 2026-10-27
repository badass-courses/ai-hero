import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { openGiftCookie, GIFT_COOKIE } from "@/lib/c5-pricing/gift-cookie";

const mocks = vi.hoisted(() => ({
  link: vi.fn(),
  click: vi.fn(),
  share: vi.fn(),
}));
vi.mock("@/lib/shortlinks-query", () => ({
  getShortlinkBySlug: mocks.link,
  recordClick: mocks.click,
}));
vi.mock("@/lib/c5-pricing/gift-share", () => ({
  giftSharePresentation: mocks.share,
}));
vi.mock("@/env.mjs", () => ({
  env: { NEXTAUTH_SECRET: "synthetic-cookie-key" },
}));
vi.mock("@/server/logger", () => ({ log: { error: vi.fn() } }));
import { GET } from "./route";
import { C5_PRODUCT_ID } from "@/lib/c5-pricing/products";
const slug = `test-${randomUUID().slice(0, 6)}`;
const expiresAt = new Date(Date.now() + 3600_000).toISOString();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.link.mockResolvedValue({
    url: "https://www.aihero.dev/cohorts/test",
    metadata: { campaign: "legend-gift", legendId: randomUUID() },
  });
  mocks.click.mockResolvedValue(undefined);
  mocks.share.mockResolvedValue({
    firstName: "Test",
    available: true,
    codeRef: "test-reference",
    expiresAt,
  });
});
const visit = () =>
  GET(
    new NextRequest(
      `https://www.aihero.dev/s/${slug}?codeRef=untrusted&utm_source=test`,
    ),
    { params: Promise.resolve({ slug }) },
  );
describe("gift shortlink redirect", () => {
  it("sets a signed httpOnly scoped cookie, via, attribution and click tracking", async () => {
    const response = await visit();
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.searchParams.get("via")).toBe(slug);
    expect(target.searchParams.get("codeRef")).toBeNull();
    expect(target.searchParams.get("utm_source")).toBe("test");
    expect(response.cookies.get("sl_ref")?.value).toBe(slug);
    const cookie = response.cookies.get(GIFT_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(
      openGiftCookie({
        value: cookie?.value,
        secret: "synthetic-cookie-key",
        productId: C5_PRODUCT_ID,
        now: Date.now(),
      })?.codeRef,
    ).toBe("test-reference");
    expect(mocks.click).toHaveBeenCalledOnce();
  });
  it.each(["spent", "closed", "unavailable"])(
    "never dead-ends a %s link",
    async (state) => {
      mocks.share.mockResolvedValue(
        state === "unavailable"
          ? null
          : { firstName: "Test", available: false, closed: state === "closed" },
      );
      const response = await visit();
      expect(response.status).toBe(307);
      expect(response.cookies.get(GIFT_COOKIE)?.value).toBe("");
      expect(response.cookies.get("sl_ref")?.value).toBe(slug);
      expect(mocks.click).toHaveBeenCalledOnce();
    },
  );
});
