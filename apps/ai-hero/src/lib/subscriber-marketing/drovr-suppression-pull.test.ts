import { CONTACT_UNSUBSCRIBED_EVENT } from "@/inngest/events/contact-unsubscribed";
import { describe, expect, it, vi } from "vitest";

import {
  DROVR_SUPPRESSION_PULL_START,
  planSuppressionStops,
  runSuppressionPull,
  suppressionPageOf,
  type DrovrSuppression,
  type DrovrSuppressionPage,
  type SuppressionPullPorts,
} from "./drovr-suppression-pull";
import {
  readDrovrSuppressions,
  suppressionsUrl,
} from "./drovr-suppression-pull-live";

const row = (over: Partial<DrovrSuppression> = {}): DrovrSuppression => ({
  contactId: "c1",
  reason: "unsubscribed",
  scope: "all",
  lifted: false,
  createdAt: "2026-11-08T01:00:00.000Z",
  ...over,
});

const page = (
  suppressions: DrovrSuppression[],
  nextCursor: string | null = null,
  resumeCursor = "resume-1",
): DrovrSuppressionPage => ({ suppressions, nextCursor, resumeCursor });

function ports(
  pages: DrovrSuppressionPage[],
  emails: Record<string, string> = { c1: "a@example.com" },
  stored?: string,
) {
  const reads: unknown[] = [];
  const writes: string[] = [];
  const sent: unknown[] = [];
  const p: SuppressionPullPorts = {
    readCursor: async () => stored,
    writeCursor: async (cursor) => {
      writes.push(cursor);
    },
    readPage: async (at) => {
      reads.push(at);
      const next = pages.shift();
      return next ? { ok: true, page: next } : { ok: false, reason: "no page" };
    },
    contactEmails: async (ids) =>
      new Map(ids.flatMap((id) => (id in emails ? [[id, emails[id]!]] : []))),
    send: async (events) => {
      sent.push(...events);
    },
  };
  return { p, reads, writes, sent };
}

describe("planSuppressionStops", () => {
  it("turns an active account-wide stop of a known contact into the K25 events", () => {
    const { events, counts } = planSuppressionStops(
      [row({ reason: "bounced" })],
      new Map([["c1", "a@example.com"]]),
    );
    expect(counts.queued).toBe(1);
    expect(events).toEqual([
      {
        id: "drovr-suppression:c1:all:bounced:2026-11-08T01:00:00.000Z:newsletter",
        name: CONTACT_UNSUBSCRIBED_EVENT,
        data: {
          email: "a@example.com",
          preferenceKey: "newsletter",
          source: "drovr-suppression:bounced",
          occurredAt: "2026-11-08T01:00:00.000Z",
        },
      },
      {
        id: "drovr-suppression:c1:all:bounced:2026-11-08T01:00:00.000Z:ai-skills",
        name: CONTACT_UNSUBSCRIBED_EVENT,
        data: {
          email: "a@example.com",
          preferenceKey: "ai-skills",
          source: "drovr-suppression:bounced",
          occurredAt: "2026-11-08T01:00:00.000Z",
        },
      },
    ]);
  });

  it("dates the stop from drovr's fact time when the row carries one", () => {
    const { events } = planSuppressionStops(
      [row({ factAt: "2026-11-07T23:00:00.000Z" })],
      new Map([["c1", "a@example.com"]]),
    );
    expect(events[0]?.data.occurredAt).toBe("2026-11-07T23:00:00.000Z");
  });

  it("leaves course scopes, lifts, unknown and email-less contacts alone, and counts each", () => {
    const { events, counts } = planSuppressionStops(
      [
        row({ scope: "course:value-path-skills-course" }),
        row({ lifted: true }),
        row({ contactId: "contact-unknown" }),
        row({ contactId: "c2" }),
      ],
      new Map([
        ["c1", "a@example.com"],
        ["c2", ""],
      ]),
    );
    expect(events).toEqual([]);
    expect(counts).toEqual({
      queued: 0,
      skippedLifted: 1,
      skippedCourseScope: 1,
      skippedUnknownContact: 1,
      skippedNoEmail: 1,
    });
  });
});

describe("suppressionPageOf", () => {
  const body = {
    suppressions: [row()],
    nextCursor: null,
    resumeCursor: "r",
  };

  it("reads a page", () => {
    expect(suppressionPageOf(body)).toEqual(page([row()], null, "r"));
  });

  it("refuses the whole page when one row is unreadable", () => {
    expect(
      suppressionPageOf({
        ...body,
        suppressions: [row(), { ...row(), reason: "paused" }],
      }),
    ).toBeUndefined();
    expect(
      suppressionPageOf({
        ...body,
        suppressions: [{ ...row(), lifted: "no" }],
      }),
    ).toBeUndefined();
    expect(suppressionPageOf({ ...body, resumeCursor: "" })).toBeUndefined();
  });
});

describe("runSuppressionPull", () => {
  it("starts a first run at the pull start, then sends and moves the cursor", async () => {
    const { p, reads, writes, sent } = ports([page([row()])]);
    const receipt = await runSuppressionPull(p);
    expect(reads).toEqual([{ since: DROVR_SUPPRESSION_PULL_START }]);
    expect(sent).toHaveLength(2);
    expect(writes).toEqual(["resume-1"]);
    expect(receipt).toMatchObject({
      status: "caught-up",
      counts: { queued: 1 },
    });
  });

  it("resumes from the stored cursor and follows next until caught up", async () => {
    const { p, reads, writes } = ports(
      [page([row()], "next-1", "resume-1"), page([], null, "resume-2")],
      undefined,
      "stored",
    );
    await runSuppressionPull(p);
    expect(reads).toEqual([{ cursor: "stored" }, { cursor: "next-1" }]);
    expect(writes).toEqual(["next-1", "resume-2"]);
  });

  it("never moves the cursor past a page whose events were not queued", async () => {
    const { p, writes } = ports([page([row()])]);
    p.send = vi.fn(async () => {
      throw new Error("inngest down");
    });
    await expect(runSuppressionPull(p)).rejects.toThrow("inngest down");
    expect(writes).toEqual([]);
  });

  it("leaves the cursor alone when drovr cannot be read", async () => {
    const { p, writes, sent } = ports([]);
    const receipt = await runSuppressionPull(p);
    expect(receipt).toMatchObject({ status: "failed", reason: "no page" });
    expect(writes).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("stops at maxPages and reports more", async () => {
    const { p } = ports([page([], "n1"), page([], "n2"), page([], null)]);
    expect(await runSuppressionPull(p, { maxPages: 2 })).toMatchObject({
      status: "more",
      counts: { pages: 2 },
    });
  });
});

describe("readDrovrSuppressions", () => {
  const config = { baseUrl: "https://drovr.test/", apiKey: "k" };
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("asks for account-wide stops only, by cursor or since", () => {
    expect(suppressionsUrl("https://drovr.test/", { since: "S" }, 5)).toBe(
      "https://drovr.test/suppressions?scope=all&limit=5&since=S",
    );
    expect(suppressionsUrl("https://drovr.test", { cursor: "C" }, 5)).toBe(
      "https://drovr.test/suppressions?scope=all&limit=5&cursor=C",
    );
  });

  it("reads a 200 page with the bearer key", async () => {
    const fetcher = respond(200, {
      suppressions: [row()],
      nextCursor: null,
      resumeCursor: "r",
    });
    const read = await readDrovrSuppressions({
      at: { since: "S" },
      config,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(read).toEqual({ ok: true, page: page([row()], null, "r") });
    const init = (
      fetcher.mock.calls as unknown as [string, RequestInit][]
    )[0]?.[1];
    expect(init).toMatchObject({
      headers: { authorization: "Bearer k" },
    });
  });

  it("fails on a non-200, an unknown shape, or an over-long cursor", async () => {
    for (const fetcher of [
      respond(403, { type: "forbidden" }),
      respond(200, { suppressions: "x" }),
      respond(200, {
        suppressions: [],
        nextCursor: null,
        resumeCursor: "x".repeat(501),
      }),
    ]) {
      const read = await readDrovrSuppressions({
        at: { since: "S" },
        config,
        fetcher: fetcher as unknown as typeof fetch,
      });
      expect(read.ok).toBe(false);
    }
  });

  it("fails when drovr is not configured", async () => {
    expect(
      await readDrovrSuppressions({
        at: { since: "S" },
        config: { baseUrl: undefined, apiKey: "k" },
      }),
    ).toEqual({ ok: false, reason: "drovr is not configured" });
  });
});
