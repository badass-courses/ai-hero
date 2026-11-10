import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cap: -1 as number | undefined,
  count: 7,
  reads: vi.fn(),
  cache: new Map<string, unknown>(),
  cached: vi.fn(),
  tag: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: () => Promise<unknown>, key: string[], options: unknown) =>
    async () => {
      mocks.cached(options);
      const id = JSON.stringify(key);
      if (!mocks.cache.has(id)) mocks.cache.set(id, await fn());
      return mocks.cache.get(id);
    },
  revalidateTag: (...args: unknown[]) => {
    mocks.tag(...args);
    mocks.cache.clear();
  },
}));
vi.mock("@/db", () => ({
  db: {
    select: (columns: object) => ({
      from: () => ({
        where: async () => {
          if ("quantityAvailable" in columns)
            return mocks.cap === undefined
              ? []
              : [{ quantityAvailable: mocks.cap }];
          mocks.reads();
          return [{ count: mocks.count }];
        },
      }),
    }),
  },
}));
vi.mock("@/server/logger", () => ({ log: { warn: mocks.warn } }));

import { getPurchaseCount } from "./purchase-count";
import {
  invalidatePurchaseCounts,
  purchaseCountWriteMethods,
  withPurchaseCountInvalidation,
} from "./purchase-count-invalidation";
import type { PurchasePort } from "@coursebuilder/core/ports";

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.cache.clear();
  mocks.cap = -1;
  mocks.count = 7;
  mocks.warn.mockResolvedValue(undefined);
});

describe("purchase counts", () => {
  it.each([0, 4, undefined])(
    "never caches capped or unknown products (%s)",
    async (cap) => {
      mocks.cap = cap;
      expect(await getPurchaseCount("product")).toBe(7);
      mocks.count = 8;
      expect(await getPurchaseCount("product")).toBe(8);
      expect(mocks.cached).not.toHaveBeenCalled();
      expect(mocks.reads).toHaveBeenCalledTimes(2);
    },
  );
  it("caches only uncapped products, keyed and tagged per product", async () => {
    expect(await getPurchaseCount("a")).toBe(7);
    mocks.count = 8;
    expect(await getPurchaseCount("a")).toBe(7);
    expect(await getPurchaseCount("b")).toBe(8);
    expect(mocks.reads).toHaveBeenCalledTimes(2);
    expect(mocks.cached).toHaveBeenCalledWith({
      tags: ["purchase-counts", "purchase-count:a"],
      revalidate: 30,
    });
  });
  it("checks the cap fresh even after an uncapped cache hit", async () => {
    await getPurchaseCount("a");
    mocks.cap = 2;
    mocks.count = 9;
    expect(await getPurchaseCount("a")).toBe(9);
    expect(mocks.cached).toHaveBeenCalledTimes(1);
  });
  it("does not serve an expired stale-while-revalidate snapshot", async () => {
    vi.useFakeTimers();
    await getPurchaseCount("a");
    mocks.count = 9;
    vi.advanceTimersByTime(30_000);
    expect(await getPurchaseCount("a")).toBe(9);
  });
  it("invalidates the count on purchase creation", async () => {
    await getPurchaseCount("a");
    mocks.count = 8;
    const adapter = withPurchaseCountInvalidation({
      createPurchase: vi.fn(async () => ({ id: "purchase" })),
    } as unknown as PurchasePort);
    await adapter.createPurchase({} as never);
    expect(mocks.tag).toHaveBeenCalledWith("purchase-counts", { expire: 0 });
    expect(await getPurchaseCount("a")).toBe(8);
  });
});

describe("purchase write decorator", () => {
  it.each(purchaseCountWriteMethods)(
    "%s preserves results and invalidates after success only",
    async (method) => {
      const result = { id: "purchase" };
      const write = vi.fn(async () => result);
      const untouched = vi.fn();
      const invalidate = vi.fn(async () => {});
      const adapter = {
        [method]: write,
        untouched,
      } as unknown as PurchasePort & { untouched: typeof untouched };
      const wrapped = withPurchaseCountInvalidation(adapter, invalidate);
      expect(wrapped.untouched).toBe(untouched);
      expect(await (wrapped[method] as Function)("argument")).toBe(result);
      expect(write).toHaveBeenCalledWith("argument");
      expect(invalidate).toHaveBeenCalledOnce();
      expect(write.mock.invocationCallOrder[0]).toBeLessThan(
        invalidate.mock.invocationCallOrder[0]!,
      );
      invalidate.mockRejectedValueOnce(new Error("cache unavailable"));
      expect(await (wrapped[method] as Function)("argument")).toBe(result);
      expect(mocks.warn).toHaveBeenCalled();
      write.mockRejectedValueOnce(new Error("write failed"));
      await expect((wrapped[method] as Function)("argument")).rejects.toThrow(
        "write failed",
      );
      expect(invalidate).toHaveBeenCalledTimes(2);
    },
  );
});
