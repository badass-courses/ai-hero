import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteExpiredAnonymousContentReadBatch,
  deleteExpiredAnonymousContentReads,
} from "./content-read-retention";

type Row = {
  id: string;
  contactId: string | null;
  userId: string | null;
  kitSubscriberId: string | null;
  emailSha256: string | null;
  occurredAt: number;
};

const state = vi.hoisted(() => ({
  rows: [] as any[],
  lastIds: [] as string[],
  selects: 0,
  after: null as number | null,
  afterBounds: [] as Array<number | null>,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    gte: (column: any, value: unknown) => {
      if (value instanceof Date) state.after = value.getTime();
      return actual.gte(column, value as any);
    },
  };
});

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (n: number) => {
              state.selects++;
              const after = state.after;
              state.after = null;
              state.afterBounds.push(after);
              const picked = [...state.rows]
                .sort((a, b) => a.occurredAt - b.occurredAt)
                .filter((r) => after === null || r.occurredAt >= after)
                .filter(
                  (r) =>
                    !r.contactId &&
                    !r.userId &&
                    !r.kitSubscriberId &&
                    !r.emailSha256,
                )
                .slice(0, n);
              state.lastIds = picked.map((r) => r.id);
              return picked.map((r) => ({
                id: r.id,
                occurredAt: new Date(r.occurredAt),
              }));
            },
          }),
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        const ids = new Set(state.lastIds);
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => !ids.has(r.id));
        return { rowsAffected: before - state.rows.length };
      },
    }),
  },
}));

describe("content read retention batching", () => {
  beforeEach(() => {
    state.rows = [];
    state.lastIds = [];
    state.selects = 0;
    state.after = null;
    state.afterBounds = [];
  });

  it("deletes only anonymous rows; identity rows survive", async () => {
    state.rows = [
      row("a"),
      { ...row("b"), userId: "u1" },
      { ...row("c"), emailSha256: "x" },
      { ...row("d"), contactId: "c1" },
      { ...row("e"), kitSubscriberId: "k1" },
    ];
    const res = await deleteExpiredAnonymousContentReadBatch({
      cutoff: new Date(),
      batchSize: 10,
    });
    expect(res).toEqual({
      selectedCount: 1,
      deletedCount: 1,
      lastOccurredAt: new Date(0).toISOString(),
    });
    expect(state.rows.map((r) => r.id)).toEqual(["b", "c", "d", "e"]);
  });

  it("loops until a short batch and sums deletedCount", async () => {
    state.rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`));
    const res = await deleteExpiredAnonymousContentReads({
      batchSize: 10,
      maxBatches: 10,
    });
    expect(state.selects).toBe(3);
    expect(res.deletedCount).toBe(25);
    expect(res.mode).toBe("write");
    expect(state.rows).toHaveLength(0);
  });

  it("respects the batch cap", async () => {
    state.rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`));
    const res = await deleteExpiredAnonymousContentReads({
      batchSize: 10,
      maxBatches: 2,
    });
    expect(state.selects).toBe(2);
    expect(res.deletedCount).toBe(20);
    expect(state.rows).toHaveLength(5);
  });

  it("carries the occurredAt cursor between batches", async () => {
    state.rows = [
      { ...row("i1", 1), userId: "u1" },
      { ...row("i2", 2), userId: "u2" },
      row("a1", 3),
      row("a2", 4),
      row("a3", 5),
    ];
    const res = await deleteExpiredAnonymousContentReads({
      batchSize: 2,
      maxBatches: 10,
    });
    expect(res.deletedCount).toBe(3);
    // first batch has no bound, the next starts at the previous batch's last occurredAt
    expect(state.afterBounds).toEqual([null, 4]);
    expect(state.rows.map((r) => r.id)).toEqual(["i1", "i2"]);
  });
});

function row(id: string, occurredAt = 0): Row {
  return {
    id,
    contactId: null,
    userId: null,
    kitSubscriberId: null,
    emailSha256: null,
    occurredAt,
  };
}
