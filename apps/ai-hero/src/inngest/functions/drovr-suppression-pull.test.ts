import { CONTACT_UNSUBSCRIBED_EVENT } from "@/inngest/events/contact-unsubscribed";
import { describe, expect, it, vi } from "vitest";

const created: { config: unknown; trigger: unknown }[] = [];
vi.mock("@/inngest/inngest.server", () => ({
  inngest: {
    createFunction: (config: unknown, trigger: unknown) => {
      created.push({ config, trigger });
      return { config, trigger };
    },
    send: vi.fn(),
  },
}));
vi.mock("@/db", () => ({ db: {} }));

describe("drovr suppression pull wiring", () => {
  it("runs on a 5-minute cron, one at a time", async () => {
    await import("./drovr-suppression-pull");
    const fn = created.find(
      (entry) =>
        (entry.config as { id?: string }).id === "drovr-suppression-pull-v1",
    );
    expect(fn?.trigger).toEqual({ cron: "*/5 * * * *" });
    expect(fn?.config).toMatchObject({
      concurrency: [{ limit: 1 }],
      singleton: { mode: "skip" },
    });
  });

  it("feeds the same event capture-contact-unsubscribed writes stops from", async () => {
    created.length = 0;
    await import("./capture-contact-unsubscribed");
    const capture = created.find(
      (entry) =>
        (entry.config as { id?: string }).id === "capture-contact-unsubscribed",
    );
    expect(capture?.trigger).toEqual({ event: CONTACT_UNSUBSCRIBED_EVENT });
  });
});
