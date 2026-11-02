import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContactEventRecord } from "@/lib/subscriber-marketing/types";

// Kit is unreachable for every case here: any Kit call fails the test.
const kit = vi.hoisted(() => ({
  getSubscriberByEmail: vi.fn(async () => {
    throw new Error("Kit is unreachable");
  }),
}));
vi.mock("@/coursebuilder/email-list-provider", () => ({
  emailListProvider: { getSubscriberByEmail: kit.getSubscriberByEmail },
}));
vi.mock("@/env.mjs", () => ({ env: {} }));
vi.mock("@/server/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  readRecoveryStanding,
  type RecoveryStandingReader,
} from "./recovery-standing";

const EMAIL = "learner@example.com";
const ENTERED_AT = "2026-09-01T10:00:00.000Z";

function event(
  eventType: string,
  occurredAt: string,
  fields: Partial<ContactEventRecord> = {},
) {
  return { eventType, occurredAt, ...fields } as ContactEventRecord;
}

function reader(
  options: {
    contact?: { id: string; email: string } | null;
    kitIds?: string[];
    events?: ContactEventRecord[];
    drovrStops?: { reason: string }[];
    failContact?: boolean;
    failEvents?: boolean;
    failDrovr?: boolean;
  } = {},
) {
  const events = options.events ?? [
    event("value-path.entered", ENTERED_AT, {
      providerReference: "value-path:ai-hero-skills-workflow",
    }),
  ];
  return {
    findContactByEmail: vi.fn(async () => {
      if (options.failContact) throw new Error("database down");
      return options.contact === null
        ? undefined
        : (options.contact ?? { id: "contact_41", email: EMAIL });
    }),
    findKitSubscriberIds: vi.fn(async () => options.kitIds ?? ["41"]),
    findContactEventsByType: vi.fn(async (_id: string, type: string) => {
      if (options.failEvents) throw new Error("database down");
      return events.filter((entry) => entry.eventType === type);
    }),
    readDrovrStops: vi.fn(async () => {
      if (options.failDrovr) throw new Error("drovr 503");
      return options.drovrStops ?? [];
    }),
  } satisfies RecoveryStandingReader;
}

describe("readRecoveryStanding (off Kit)", () => {
  beforeEach(() => {
    kit.getSubscriberByEmail.mockClear();
  });

  it("subscribed: directory contact, Kit alias, course entry, no stops", async () => {
    const standing = await readRecoveryStanding({
      email: " Learner@Example.com ",
      reader: reader(),
    });
    expect(standing).toEqual({
      state: "subscribed",
      contactId: "contact_41",
      email: EMAIL,
      kitSubscriberId: "41",
    });
    expect(kit.getSubscriberByEmail).not.toHaveBeenCalled();
  });

  it("subscribed: a drovr-owned contact enters the course by owner assignment", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      reader: reader({
        events: [
          event("journey.owner.assigned", ENTERED_AT, {
            providerEventId: "owner:contact_41:value-path-skills-course",
          }),
        ],
      }),
    });
    expect(standing.state).toBe("subscribed");
  });

  it("stopped: a local unsubscribe", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      reader: reader({
        events: [
          event("value-path.entered", ENTERED_AT, {
            providerReference: "value-path:ai-hero-skills-workflow",
          }),
          event("contact.unsubscribed", "2026-09-02T10:00:00.000Z"),
        ],
      }),
    });
    expect(standing).toEqual({
      state: "stopped",
      reason: "unsubscribed",
      source: "local",
    });
  });

  it("stopped: a fresh opt-in after course entry never restarts the course", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      reader: reader({
        events: [
          event("value-path.entered", ENTERED_AT, {
            providerReference: "value-path:ai-hero-skills-workflow",
          }),
          event("contact.unsubscribed", "2026-09-02T10:00:00.000Z"),
          event("contact.resubscribed", "2026-09-03T10:00:00.000Z"),
        ],
      }),
    });
    expect(standing).toMatchObject({
      state: "stopped",
      reason: "unsubscribed",
    });
  });

  it("stopped: a bounce never lifts", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      reader: reader({
        events: [
          event("value-path.entered", ENTERED_AT, {
            providerReference: "value-path:ai-hero-skills-workflow",
          }),
          event("contact.bounced", "2026-09-02T10:00:00.000Z"),
        ],
      }),
    });
    expect(standing).toMatchObject({ state: "stopped", reason: "bounced" });
  });

  it("stopped: an active drovr stop for the Kit alias", async () => {
    const r = reader({ drovrStops: [{ reason: "unsubscribed" }] });
    const standing = await readRecoveryStanding({ email: EMAIL, reader: r });
    expect(standing).toEqual({
      state: "stopped",
      reason: "unsubscribed",
      source: "drovr",
    });
    expect(r.readDrovrStops).toHaveBeenCalledWith("41");
  });

  it("unknown: drovr unreadable fails closed", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      reader: reader({ failDrovr: true }),
    });
    expect(standing).toEqual({
      state: "unknown",
      reason: "drovr-stops-unreadable",
    });
  });

  it("unknown: the directory unreadable fails closed", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      reader: reader({ failContact: true }),
    });
    expect(standing).toEqual({
      state: "unknown",
      reason: "directory-unreadable",
    });
  });

  it("unknown: local stop evidence unreadable fails closed, drovr unread", async () => {
    const r = reader({ failEvents: true });
    const standing = await readRecoveryStanding({ email: EMAIL, reader: r });
    expect(standing).toEqual({
      state: "unknown",
      reason: "local-stops-unreadable",
    });
    expect(r.readDrovrStops).not.toHaveBeenCalled();
  });

  it("unknown: two Kit aliases with no trusted id to pick one", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      reader: reader({ kitIds: ["41", "52"] }),
    });
    expect(standing).toEqual({
      state: "unknown",
      reason: "kit-identity-ambiguous",
    });
  });

  it("a trusted Kit id picks its alias", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      expectedKitSubscriberId: "52",
      reader: reader({ kitIds: ["41", "52"] }),
    });
    expect(standing).toMatchObject({
      state: "subscribed",
      kitSubscriberId: "52",
    });
  });

  it("not found: no directory contact", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      reader: reader({ contact: null }),
    });
    expect(standing).toEqual({
      state: "not-found",
      reason: "contact-not-found",
    });
  });

  it("not found: a trusted Kit id the contact does not carry", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      expectedKitSubscriberId: "999",
      reader: reader(),
    });
    expect(standing).toEqual({
      state: "not-found",
      reason: "kit-identity-not-found",
    });
  });

  it("not found: no course entry, whatever other path the contact is on", async () => {
    const standing = await readRecoveryStanding({
      email: EMAIL,
      reader: reader({
        events: [
          event("value-path.entered", ENTERED_AT, {
            providerReference: "value-path:some-other-path",
          }),
        ],
      }),
    });
    expect(standing).toEqual({
      state: "not-found",
      reason: "course-entry-not-found",
    });
  });
});
