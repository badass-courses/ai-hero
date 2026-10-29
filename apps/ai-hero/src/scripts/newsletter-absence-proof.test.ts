import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect4";
import { createHeldRecoveryPorts } from "../../scripts/held-exit-recover-runtime";
import {
  runNewsletterAbsenceProof,
  runNewsletterAbsenceProofCommand,
  type AbsenceProofRuntime,
} from "../../scripts/newsletter-absence-proof";
import {
  NEWSLETTER_PROTECTED_COHORT,
  OLD_NEWSLETTER_EXIT_CONFIRMED,
  OLD_NEWSLETTER_REFERENCE,
  OLD_NEWSLETTER_SUBSCRIBED,
  readOldSequenceMembership,
} from "../lib/subscriber-marketing/old-newsletter-exit";
import type {
  ContactEventRecord,
  ContactRecord,
} from "../lib/subscriber-marketing/types";

const start = "2026-10-29T19:00:00.000Z";
const contact = (id: string): ContactRecord => ({
  id,
  email: `${id}@example.test`,
  name: "Fixture",
  lifecycle: "nurture-ready",
  isProvisional: false,
  createdAt: start,
  updatedAt: start,
});
const kitIds: Record<string, string> = {
  member: "1",
  nonMember: "2",
  secondNonMember: "3",
  protectedReader: "4",
};

function world(options: { kitStatus?: number } = {}) {
  let now = start;
  const contacts = [
    "member",
    "nonMember",
    "secondNonMember",
    "protectedReader",
    "noIdentity",
  ].map(contact);
  const events: ContactEventRecord[] = [
    {
      id: "protected",
      contactId: "protectedReader",
      eventType: NEWSLETTER_PROTECTED_COHORT,
      provider: "kit",
      occurredAt: start,
      createdAt: start,
    } as ContactEventRecord,
  ];
  const createContactEvent = vi.fn(
    async (input: Omit<ContactEventRecord, "id">) => {
      const existing = events.find(
        (event) =>
          event.semanticIdempotencyKey === input.semanticIdempotencyKey,
      );
      if (existing) return existing;
      const record = {
        ...input,
        id: `event-${events.length}`,
      } as ContactEventRecord;
      events.push(record);
      return record;
    },
  );
  const repository = {
    findContactById: async (id: string) =>
      contacts.find((item) => item.id === id),
    findContactEventsByType: async (id: string, type: string) =>
      events.filter(
        (event) => event.contactId === id && event.eventType === type,
      ),
    createContactEvent,
  };
  const kitFetch = vi.fn(async () =>
    options.kitStatus
      ? new Response("{}", { status: options.kitStatus })
      : new Response(
          JSON.stringify({
            subscribers: [{ id: Number(kitIds.member) }],
            pagination: { has_next_page: false, total_count: 1 },
          }),
        ),
  );
  const runtime: AbsenceProofRuntime = createHeldRecoveryPorts({
    repository,
    apiKey: "fixture-kit-key",
    eventKey: "",
    deploymentScope: "fixture",
    fetch: kitFetch as unknown as typeof fetch,
    now: () => now,
    findRows: async () => [],
    findKitIdentities: async (id) =>
      kitIds[id]
        ? [{ id: `identity-${id}`, contactId: id, externalId: kitIds[id]! }]
        : [],
    readOutbox: async () => {
      throw new Error("not used");
    },
  });
  return {
    runtime,
    events,
    createContactEvent,
    kitFetch,
    membership: (id: string) => readOldSequenceMembership(repository, id),
    advance: (ms: number) => {
      now = new Date(Date.parse(now) + ms).toISOString();
    },
  };
}

const ids = [
  "member",
  "nonMember",
  "secondNonMember",
  "protectedReader",
  "noIdentity",
  "unknown",
];
const run = (
  w: ReturnType<typeof world>,
  args: Parameters<typeof runNewsletterAbsenceProof>[0],
) => Effect.runPromise(runNewsletterAbsenceProof(args, w.runtime));

describe("newsletter absence proof (Ruling A recovery)", () => {
  it("dry run counts each class with one shared scan and writes nothing", async () => {
    const w = world();
    const plan = await run(w, { mode: "dry-run", contactIds: ids });
    expect(plan).toMatchObject({
      status: "planned",
      contacts: 6,
      classes: {
        "contact-missing": 1,
        "already-proven": 0,
        "protected-cohort": 1,
        "identity-unproven": 1,
        "old-sequence-member": 1,
        absent: 2,
      },
      writes: { written: 0 },
    });
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(w.kitFetch).toHaveBeenCalledTimes(1);
    expect(w.createContactEvent).not.toHaveBeenCalled();
    for (const id of [...ids, "example.test", "identity-member"])
      expect(JSON.stringify(plan)).not.toContain(`"${id}`);
  });

  it("writes exit proof for non-members only, which the send gate then accepts", async () => {
    const w = world();
    const plan = await run(w, { mode: "dry-run", contactIds: ids });
    const written = await run(w, {
      mode: "write",
      contactIds: ids,
      approval: "desk-fixture",
      planHash: plan.planHash!,
    });
    expect(written).toMatchObject({
      status: "written",
      writes: { written: 2 },
    });
    expect(await w.membership("nonMember")).toBe("exited");
    expect(await w.membership("secondNonMember")).toBe("exited");
    expect(await w.membership("member")).toBe("unknown");
    expect(await w.membership("protectedReader")).toBe("unknown");
    const receipt = w.events.find(
      (event) =>
        event.contactId === "nonMember" &&
        event.eventType === OLD_NEWSLETTER_EXIT_CONFIRMED,
    );
    expect(receipt).toMatchObject({
      provider: "kit",
      providerReference: OLD_NEWSLETTER_REFERENCE,
      occurredAt: start,
    });
  });

  it("an absent reader listed before a member still gets its proof", async () => {
    const w = world();
    const order = ["nonMember", "member"];
    const plan = await run(w, { mode: "dry-run", contactIds: order });
    const written = await run(w, {
      mode: "write",
      contactIds: order,
      approval: "desk-fixture",
      planHash: plan.planHash!,
    });
    expect(written).toMatchObject({
      status: "written",
      writes: { written: 1, "proof-expired": 0 },
    });
    expect(await w.membership("nonMember")).toBe("exited");
    expect(await w.membership("member")).toBe("unknown");
  });

  it("a failure part-way reports the receipts that did land", async () => {
    const w = world();
    const plan = await run(w, { mode: "dry-run", contactIds: ids });
    const persist = w.runtime.persist;
    let calls = 0;
    const runtime: AbsenceProofRuntime = {
      ...w.runtime,
      persist: async (input) => {
        calls += 1;
        if (calls === 2) throw new Error("connection reset");
        return persist(input);
      },
    };
    const result = await Effect.runPromise(
      runNewsletterAbsenceProof(
        {
          mode: "write",
          contactIds: ids,
          approval: "desk-fixture",
          planHash: plan.planHash!,
        },
        runtime,
      ),
    );
    expect(result).toMatchObject({
      status: "partial",
      reason: "database-unavailable",
      writes: { written: 1, failed: 1 },
    });
    expect(
      w.events.filter(
        (event) => event.eventType === OLD_NEWSLETTER_EXIT_CONFIRMED,
      ),
    ).toHaveLength(1);
  });

  it("a receipt the gate cannot read back still counts as landed", async () => {
    const w = world();
    const plan = await run(w, { mode: "dry-run", contactIds: ids });
    let reads = 0;
    const runtime: AbsenceProofRuntime = {
      ...w.runtime,
      currentMembership: async (id) => {
        reads += 1;
        if (reads > ids.length + 2) throw new Error("read failed");
        return w.runtime.currentMembership(id);
      },
    };
    const result = await Effect.runPromise(
      runNewsletterAbsenceProof(
        {
          mode: "write",
          contactIds: ids,
          approval: "desk-fixture",
          planHash: plan.planHash!,
        },
        runtime,
      ),
    );
    expect(result.status).toBe("partial");
    expect(result.reason).toBe("receipt-not-current");
    expect(result.writes.written + result.writes["written-unverified"]).toBe(
      w.events.filter(
        (event) => event.eventType === OLD_NEWSLETTER_EXIT_CONFIRMED,
      ).length,
    );
    expect(result.writes["written-unverified"]).toBeGreaterThan(0);
  });

  it("a re-run writes no second proof", async () => {
    const w = world();
    const plan = await run(w, { mode: "dry-run", contactIds: ids });
    const write = {
      mode: "write" as const,
      contactIds: ids,
      approval: "desk-fixture",
    };
    await run(w, { ...write, planHash: plan.planHash! });
    const again = await run(w, { mode: "dry-run", contactIds: ids });
    expect(again.classes).toMatchObject({ "already-proven": 2, absent: 0 });
    await run(w, { ...write, planHash: again.planHash! });
    expect(
      w.events.filter(
        (event) => event.eventType === OLD_NEWSLETTER_EXIT_CONFIRMED,
      ),
    ).toHaveLength(2);
  });

  it("a failed Kit read refuses the whole run and writes nothing", async () => {
    const w = world({ kitStatus: 404 });
    expect(await run(w, { mode: "dry-run", contactIds: ids })).toMatchObject({
      status: "refused",
      reason: "provider-unavailable",
      planHash: null,
    });
    expect(w.createContactEvent).not.toHaveBeenCalled();
  });

  it("a plan hash from another plan writes nothing", async () => {
    const w = world();
    expect(
      await run(w, {
        mode: "write",
        contactIds: ids,
        approval: "desk-fixture",
        planHash: "a".repeat(64),
      }),
    ).toMatchObject({ status: "refused", reason: "plan-hash-mismatch" });
    expect(w.createContactEvent).not.toHaveBeenCalled();
  });

  it("expired proof writes nothing", async () => {
    const w = world();
    const plan = await run(w, { mode: "dry-run", contactIds: ids });
    w.advance(16 * 60_000);
    const late = await run(w, {
      mode: "write",
      contactIds: ids,
      approval: "desk-fixture",
      planHash: plan.planHash!,
    });
    expect(late.status).toBe("refused");
    expect(w.createContactEvent).not.toHaveBeenCalled();
  });

  it("skips a reader whose history changes during the write", async () => {
    const w = world();
    const plan = await run(w, { mode: "dry-run", contactIds: ids });
    let reads = 0;
    const runtime: AbsenceProofRuntime = {
      ...w.runtime,
      inspect: async (id) => {
        const state = await w.runtime.inspect(id);
        if (id !== "nonMember") return state;
        reads += 1;
        return reads > 1
          ? {
              ...state,
              history: [
                ...state.history,
                {
                  id: "late",
                  contactId: id,
                  eventType: OLD_NEWSLETTER_SUBSCRIBED,
                } as ContactEventRecord,
              ],
            }
          : state;
      },
    };
    const written = await Effect.runPromise(
      runNewsletterAbsenceProof(
        {
          mode: "write",
          contactIds: ids,
          approval: "desk-fixture",
          planHash: plan.planHash!,
        },
        runtime,
      ),
    );
    expect(written).toMatchObject({
      status: "partial",
      writes: { written: 1, "snapshot-changed": 1 },
    });
    expect(await w.membership("nonMember")).toBe("unknown");
  });

  it("the command reads the private id file and prints counts only", async () => {
    const w = world();
    const result = await Effect.runPromise(
      runNewsletterAbsenceProofCommand(
        ["--file", "/private/ids.json"],
        async () => ({ runtime: w.runtime, close: async () => {} }),
        async () => JSON.stringify({ contactIds: ids }),
      ),
    );
    expect(result).toMatchObject({ status: "planned", contacts: 6 });
    const duplicate = await Effect.runPromise(
      runNewsletterAbsenceProofCommand(
        ["--file", "/private/ids.json"],
        async () => ({ runtime: w.runtime, close: async () => {} }),
        async () => JSON.stringify({ contactIds: ["a", "a"] }),
      ),
    );
    expect(duplicate).toMatchObject({
      status: "refused",
      reason: "input-invalid",
    });
    const unapproved = await Effect.runPromise(
      runNewsletterAbsenceProofCommand(
        [
          "--file",
          "/private/ids.json",
          "--write",
          "--plan-hash",
          "a".repeat(64),
        ],
        async () => ({ runtime: w.runtime, close: async () => {} }),
        async () => JSON.stringify({ contactIds: ids }),
      ),
    );
    expect(unapproved).toMatchObject({
      status: "refused",
      reason: "approval-required",
    });
  });
});
