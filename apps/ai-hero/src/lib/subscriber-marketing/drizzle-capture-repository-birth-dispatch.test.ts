import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => ({
  awaited: vi.fn(),
  safely: vi.fn(),
}));

vi.mock("./drovr-shadow-dispatch", () => ({
  dispatchDrovrShadowFactAwaited: dispatch.awaited,
  dispatchDrovrShadowFactSafely: dispatch.safely,
}));

import { DrizzleCaptureMarketingRepository } from "./drizzle-capture-repository";
import type { ContactEventRecord } from "./types";

type Input = Omit<ContactEventRecord, "id" | "createdAt">;

function contactEventInput(eventType: string): Input {
  return {
    contactId: "contact-1",
    providerIdentityId: "identity-1",
    provider: "ai-hero",
    providerEventId: `drovr-owner:contact-1:value-path-skills-course`,
    providerReference: "value-path-skills-course",
    eventType,
    occurredAt: "2026-09-27T14:00:00.000Z",
    semanticIdempotencyKey: `semantic:${eventType}:contact-1`,
    privacyLevel: "internal",
    identityEvidence: {
      source: "ai-hero",
      strength: "strong",
      providerIdentity: { provider: "ai-hero", externalId: "contact-1" },
    },
    payloadSummary: {
      summary: "not forwarded",
      keywords: [],
      restrictedPayloadStored: false,
    },
    schemaVersion: 1,
  };
}

function repository() {
  const database = {
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
  return new DrizzleCaptureMarketingRepository(database as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the owner-assignment (birth) dispatch", () => {
  // 2026-09-27: six value-path births were never enqueued. The dispatch was
  // fire-and-forget, and the step's lambda froze before inngest.send landed.
  it("is awaited: the write does not return before the birth is handed off", async () => {
    let release!: () => void;
    dispatch.awaited.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let returned = false;
    const write = repository()
      .createContactEvent(contactEventInput("journey.owner.assigned"))
      .then((record) => {
        returned = true;
        return record;
      });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(returned).toBe(false);
    expect(dispatch.awaited).toHaveBeenCalledWith({
      kind: "contact-event",
      event: expect.objectContaining({
        eventType: "journey.owner.assigned",
        contactId: "contact-1",
      }),
    });
    expect(dispatch.safely).not.toHaveBeenCalled();

    release();
    await expect(write).resolves.toMatchObject({
      eventType: "journey.owner.assigned",
    });
    expect(returned).toBe(true);
  });

  // Row 194, 2026-09-27: a coupon buyer's purchase.recorded was written but
  // never reached drovr, so the offer went on to send "ends tonight" to a
  // customer. Same fire-and-forget loss as the births above.
  it("awaits a purchase.recorded too: the write does not return before the hand-off", async () => {
    let release!: () => void;
    dispatch.awaited.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let returned = false;
    const write = repository()
      .createContactEvent(contactEventInput("purchase.recorded"))
      .then((record) => {
        returned = true;
        return record;
      });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(returned).toBe(false);
    expect(dispatch.awaited).toHaveBeenCalledWith({
      kind: "contact-event",
      event: expect.objectContaining({ eventType: "purchase.recorded" }),
    });
    expect(dispatch.safely).not.toHaveBeenCalled();

    release();
    await expect(write).resolves.toMatchObject({
      eventType: "purchase.recorded",
    });
  });

  it("leaves every other contact event on the fire-and-forget path", async () => {
    await repository().createContactEvent(
      contactEventInput("skills-newsletter.subscribed"),
    );
    expect(dispatch.safely).toHaveBeenCalledOnce();
    expect(dispatch.awaited).not.toHaveBeenCalled();
  });
});
