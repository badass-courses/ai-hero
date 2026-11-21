import { createMongoAbility } from "@casl/ability";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  createAndAttach: vi.fn(),
  updateHours: vi.fn(),
  getEvent: vi.fn(),
  getPurchasers: vi.fn(),
  getEmail: vi.fn(),
  updateEmail: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ products: {}, purchases: {} }));
vi.mock("@/emails/basic-email", () => ({ default: () => null }));
vi.mock("@/env.mjs", () => ({
  env: {
    NEXT_PUBLIC_URL: "https://example.test",
    NEXT_PUBLIC_SITE_TITLE: "Test",
    NEXT_PUBLIC_SUPPORT_EMAIL: "support@example.test",
  },
}));
vi.mock("@/lib/emails-query", () => ({
  getEmailSimple: mocks.getEmail,
  updateEmailSimple: mocks.updateEmail,
}));
vi.mock("@/lib/events-query", () => ({
  attachReminderEmailToEvent: mocks.attach,
  createAndAttachReminderEmailToEvent: mocks.createAndAttach,
  detachReminderEmailFromEvent: mocks.detach,
  getAllReminderEmails: vi.fn(),
  getEvent: mocks.getEvent,
  getEventPurchasers: mocks.getPurchasers,
  getEventReminderEmails: vi.fn(),
  updateReminderEmailHours: mocks.updateHours,
}));
vi.mock("@/server/auth", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: { error: vi.fn() } }));
vi.mock("@coursebuilder/utils/send-an-email", () => ({
  sendAnEmail: mocks.send,
}));

import { eventsRouter } from "./events";

function caller(role: "learner" | "editor") {
  return eventsRouter.createCaller({
    session: { user: { id: "u1" } },
    ability: createMongoAbility(
      role === "editor"
        ? [{ action: "create", subject: "Content" }]
        : [{ action: "read", subject: "Content" }],
    ),
    headers: new Headers(),
    db: {},
  } as any);
}

const ids = { eventId: "event-1", emailId: "email-1" };
const fields = {
  title: "Reminder",
  subject: "Hi {{ user.name }}",
  body: "Body",
};

function calls(c: ReturnType<typeof caller>) {
  return {
    attachReminderEmailToEvent: () => c.attachReminderEmailToEvent(ids),
    detachReminderEmailFromEvent: () => c.detachReminderEmailFromEvent(ids),
    createAndAttachReminderEmailToEvent: () =>
      c.createAndAttachReminderEmailToEvent({
        eventId: ids.eventId,
        input: { fields },
      } as any),
    updateReminderEmailHours: () =>
      c.updateReminderEmailHours({ ...ids, hoursInAdvance: 24 }),
    updateReminderEmail: () =>
      c.updateReminderEmail({ ...ids, hoursInAdvance: 24, fields } as any),
    previewReminderEmail: () => c.previewReminderEmail(ids),
    sendReminderEmailNow: () => c.sendReminderEmailNow(ids),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEvent.mockResolvedValue({
    fields: { title: "Event", slug: "event" },
  });
  mocks.getEmail.mockResolvedValue({ id: "email-1", fields });
  mocks.getPurchasers.mockResolvedValue([
    { name: "Buyer", email: "buyer@example.test" },
  ]);
});

describe("events reminder-email procedures", () => {
  it.each(Object.keys(calls(caller("learner"))))(
    "%s refuses a logged-in non-editor before reading, writing or sending",
    async (name) => {
      const run = calls(caller("learner"))[
        name as keyof ReturnType<typeof calls>
      ];
      await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
      for (const fn of Object.values(mocks)) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it("lets a content editor preview recipients", async () => {
    const out = await caller("editor").previewReminderEmail(ids);
    expect(out.recipientCount).toBe(1);
    expect(out.subject).toBe("Hi Buyer");
  });

  it("lets a content editor send", async () => {
    const out = await caller("editor").sendReminderEmailNow(ids);
    expect(out).toMatchObject({ sent: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
