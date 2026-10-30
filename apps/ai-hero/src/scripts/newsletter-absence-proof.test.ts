import { mkdtemp, chmod, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createHeldRecoveryPorts } from "../../scripts/held-exit-recover-runtime";
import {
  nodePlanFiles,
  planFileHash,
  planNewsletterAbsenceProof,
  runNewsletterAbsenceProof,
  runNewsletterAbsenceProofCommand,
  type AbsencePlanFiles,
  type AbsenceProofRuntime,
  type AbsenceRecheckRuntime,
} from "../../scripts/newsletter-absence-proof";
import {
  addedAfterDate,
  createKitAbsenceRecheck,
} from "../../scripts/newsletter-absence-recheck";
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
  stopped: "5",
  kitGone: "6",
  readded: "7",
  flaky: "8",
  outsider: "9",
};

function world(options: { kitStatus?: number; deployment?: string } = {}) {
  let now = start;
  const contacts = [...Object.keys(kitIds), "noIdentity"].map(contact);
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
  // Write-time state, changed by a test after the snapshot.
  const changes = {
    drovrStopped: new Set<string>(),
    kitStates: new Map<string, string>(),
    addedSince: new Set<string>(),
    unreadable: new Set<string>(),
  };
  const recheck = {
    drovrStopped: vi.fn(async (contactId: string) => {
      if (changes.unreadable.has(contactId)) throw new Error("drovr 503");
      return changes.drovrStopped.has(contactId);
    }),
    kitSubscriberState: vi.fn(
      async (subscriberId: string) =>
        changes.kitStates.get(subscriberId) ?? "active",
    ),
    oldSequenceAddedSince: vi.fn(async (subscriberId: string) =>
      changes.addedSince.has(subscriberId),
    ),
  } satisfies AbsenceRecheckRuntime;
  const runtime: AbsenceProofRuntime = {
    ...createHeldRecoveryPorts({
      repository,
      apiKey: "fixture-kit-key",
      eventKey: "",
      deploymentScope: options.deployment ?? "fixture",
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
    }),
    recheck,
  };
  return {
    runtime,
    events,
    createContactEvent,
    kitFetch,
    recheck,
    changes,
    membership: (id: string) => readOldSequenceMembership(repository, id),
    receipts: () =>
      events.filter(
        (event) => event.eventType === OLD_NEWSLETTER_EXIT_CONFIRMED,
      ),
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
const planOf = async (w: ReturnType<typeof world>, contactIds = ids) => {
  const { envelope, plan } = await Effect.runPromise(
    planNewsletterAbsenceProof(contactIds, w.runtime),
  );
  return { envelope, plan: plan! };
};
const write = (
  w: ReturnType<typeof world>,
  plan: string,
  runtime: AbsenceProofRuntime = w.runtime,
) =>
  Effect.runPromise(
    runNewsletterAbsenceProof(
      {
        mode: "write",
        plan,
        approval: "desk-fixture",
        expectPlanHash: planFileHash(plan),
      },
      runtime,
    ),
  );

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

  it("the plan pins ids and classes, hashes as written, and carries no emails", async () => {
    const w = world();
    const { envelope, plan } = await planOf(w);
    expect(envelope.planHash).toBe(planFileHash(plan));
    expect(plan).not.toContain("example.test");
    expect(plan).not.toContain("Fixture");
    const parsed = JSON.parse(plan);
    expect(parsed.classes).toEqual(envelope.classes);
    expect(parsed.scan.fingerprint).toBe(envelope.scan?.fingerprint);
    expect(
      parsed.decisions
        .filter((decision: { class: string }) => decision.class === "absent")
        .map((decision: { contactId: string }) => decision.contactId),
    ).toEqual(["nonMember", "secondNonMember"]);
  });

  it("writes exit proof for non-members only, which the send gate then accepts", async () => {
    const w = world();
    const { plan } = await planOf(w);
    const written = await write(w, plan);
    expect(written).toMatchObject({
      status: "written",
      planHash: planFileHash(plan),
      writes: { written: 2, skipped: 0, failed: 0 },
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

  it("the write reads the plan and never re-scans Kit, however long after", async () => {
    const w = world();
    const { plan } = await planOf(w);
    expect(w.kitFetch).toHaveBeenCalledTimes(1);
    // The live scan takes ~29 minutes; the 15-minute proof age must not matter.
    w.advance(3 * 60 * 60_000);
    const written = await write(w, plan);
    expect(written).toMatchObject({
      status: "written",
      writes: { written: 2 },
    });
    expect(w.kitFetch).toHaveBeenCalledTimes(1);
    expect(w.recheck.oldSequenceAddedSince).toHaveBeenCalledWith("2", start);
  });

  it("an absent reader listed before a member still gets its proof", async () => {
    const w = world();
    const { plan } = await planOf(w, ["nonMember", "member"]);
    const written = await write(w, plan);
    expect(written).toMatchObject({
      status: "written",
      writes: { written: 1, skipped: 0 },
    });
    expect(await w.membership("nonMember")).toBe("exited");
    expect(await w.membership("member")).toBe("unknown");
  });

  it("a failure part-way reports the receipts that did land", async () => {
    const w = world();
    const { plan } = await planOf(w);
    const persist = w.runtime.persist;
    let calls = 0;
    const result = await write(w, plan, {
      ...w.runtime,
      persist: async (input) => {
        calls += 1;
        if (calls === 2) throw new Error("connection reset");
        return persist(input);
      },
    });
    expect(result).toMatchObject({
      status: "partial",
      reason: "database-unavailable",
      writes: { written: 1, failed: 1 },
    });
    expect(w.receipts()).toHaveLength(1);
  });

  it("a receipt the gate cannot read back still counts as landed", async () => {
    const w = world();
    const { plan } = await planOf(w);
    const persisted = new Set<string>();
    const result = await write(w, plan, {
      ...w.runtime,
      persist: async (input) => {
        persisted.add(input.contactId);
        return w.runtime.persist(input);
      },
      currentMembership: async (id) => {
        if (persisted.has(id)) throw new Error("read failed");
        return w.runtime.currentMembership(id);
      },
    });
    expect(result.status).toBe("partial");
    expect(result.reason).toBe("receipt-not-current");
    expect(result.writes.written + result.writes["written-unverified"]).toBe(
      w.receipts().length,
    );
    expect(result.writes["written-unverified"]).toBeGreaterThan(0);
  });

  it("a re-run writes no second proof", async () => {
    const w = world();
    const { plan } = await planOf(w);
    await write(w, plan);
    const same = await write(w, plan);
    expect(same).toMatchObject({
      writes: { written: 0, skipped: 2 },
      skipped: { "already-proven": 2 },
    });
    w.advance(16 * 60_000);
    const again = await planOf(w);
    expect(again.envelope.classes).toMatchObject({
      "already-proven": 2,
      absent: 0,
    });
    await write(w, again.plan);
    expect(w.receipts()).toHaveLength(2);
  });

  it("a failed Kit read refuses the whole run and writes nothing", async () => {
    const w = world({ kitStatus: 404 });
    const { envelope, plan } = await Effect.runPromise(
      planNewsletterAbsenceProof(ids, w.runtime),
    );
    expect(envelope).toMatchObject({
      status: "refused",
      reason: "provider-unavailable",
      planHash: null,
    });
    expect(plan).toBeNull();
    expect(w.createContactEvent).not.toHaveBeenCalled();
  });

  it("a hash mismatch refuses and writes nothing", async () => {
    const w = world();
    const { plan } = await planOf(w);
    const refuse = (expectPlanHash: string, text = plan) =>
      Effect.runPromise(
        runNewsletterAbsenceProof(
          {
            mode: "write",
            plan: text,
            approval: "desk-fixture",
            expectPlanHash,
          },
          w.runtime,
        ),
      );
    expect(await refuse("a".repeat(64))).toMatchObject({
      status: "refused",
      reason: "plan-hash-mismatch",
      planHash: null,
    });
    // An edited plan no longer matches the approved hash.
    const edited = plan.replace('"protected-cohort"', '"absent"');
    expect(edited).not.toBe(plan);
    expect(await refuse(planFileHash(plan), edited)).toMatchObject({
      status: "refused",
      reason: "plan-hash-mismatch",
    });
    expect(w.createContactEvent).not.toHaveBeenCalled();
    expect(w.recheck.drovrStopped).not.toHaveBeenCalled();
  });

  it("a plan from another deployment or Kit account writes nothing", async () => {
    const planned = world({ deployment: "staging" });
    const { plan } = await planOf(planned);
    const w = world();
    expect(await write(w, plan)).toMatchObject({
      status: "refused",
      reason: "plan-scope-mismatch",
    });
    expect(w.createContactEvent).not.toHaveBeenCalled();
  });

  it("skips and counts each reader whose state changed since the snapshot", async () => {
    const w = world();
    const contactIds = [
      "member",
      "nonMember",
      "secondNonMember",
      "stopped",
      "kitGone",
      "readded",
      "flaky",
    ];
    const { envelope, plan } = await planOf(w, contactIds);
    expect(envelope.classes.absent).toBe(6);
    w.changes.drovrStopped.add("stopped");
    w.changes.kitStates.set(kitIds.kitGone!, "cancelled");
    w.changes.addedSince.add(kitIds.readded!);
    w.changes.unreadable.add("flaky");
    w.events.push({
      id: "late",
      contactId: "secondNonMember",
      eventType: OLD_NEWSLETTER_SUBSCRIBED,
      occurredAt: start,
      createdAt: start,
    } as ContactEventRecord);
    const result = await write(w, plan);
    expect(result).toMatchObject({
      status: "partial",
      reason: "recheck-unavailable",
      contacts: 7,
      writes: { written: 1, "written-unverified": 0, skipped: 5, failed: 0 },
      skipped: {
        "already-proven": 0,
        "snapshot-changed": 1,
        "drovr-stopped": 1,
        "kit-unsubscribed": 1,
        "old-sequence-member": 1,
        "recheck-unavailable": 1,
      },
    });
    expect(w.receipts().map((event) => event.contactId)).toEqual(["nonMember"]);
    for (const id of [...contactIds, "example.test"])
      expect(JSON.stringify(result)).not.toContain(`"${id}`);
  });

  it("never writes a reader outside the plan's absent set", async () => {
    const w = world();
    // outsider is absent from 2625552 too, but the plan never saw it.
    const { plan } = await planOf(w, [
      "member",
      "nonMember",
      "protectedReader",
    ]);
    const persisted: string[] = [];
    const result = await write(w, plan, {
      ...w.runtime,
      persist: async (input) => {
        persisted.push(input.contactId);
        return w.runtime.persist(input);
      },
    });
    expect(result).toMatchObject({ status: "written", writes: { written: 1 } });
    expect(persisted).toEqual(["nonMember"]);
    expect(w.recheck.drovrStopped.mock.calls.map(([id]) => id)).toEqual([
      "nonMember",
    ]);
    expect(await w.membership("outsider")).toBe("unknown");
    expect(await w.membership("protectedReader")).toBe("unknown");
  });

  it("a write without the recheck ports refuses", async () => {
    const w = world();
    const { plan } = await planOf(w);
    const { recheck: _recheck, ...runtime } = w.runtime;
    expect(await write(w, plan, runtime)).toMatchObject({
      status: "refused",
      reason: "runtime-unavailable",
    });
    expect(w.createContactEvent).not.toHaveBeenCalled();
  });

  it("the plan file is created 0600, never overwrites, and is read only when private", async () => {
    const directory = await mkdtemp(join(tmpdir(), "absence-plan-"));
    const path = join(directory, "plan.json");
    await nodePlanFiles.prepare(path);
    await nodePlanFiles.write(path, "{}\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await nodePlanFiles.read(path)).toBe("{}\n");
    await expect(nodePlanFiles.prepare(path)).rejects.toMatchObject({
      reason: "plan-exists",
    });
    await expect(nodePlanFiles.write(path, "x")).rejects.toMatchObject({
      reason: "plan-exists",
    });
    const open = join(directory, "open.json");
    await writeFile(open, "{}\n");
    await chmod(open, 0o644);
    await expect(nodePlanFiles.read(open)).rejects.toMatchObject({
      reason: "plan-unsafe",
    });
  });

  it("the command saves the plan, then writes from it, printing counts only", async () => {
    const w = world();
    const saved = new Map<string, string>();
    const files: AbsencePlanFiles = {
      prepare: async (path) => {
        if (saved.has(path)) throw new Error("exists");
      },
      write: async (path, text) => {
        saved.set(path, text);
      },
      read: async (path) => saved.get(path)!,
    };
    const load = async () => ({ runtime: w.runtime, close: async () => {} });
    const command = (argv: string[], input = { contactIds: ids }) =>
      Effect.runPromise(
        runNewsletterAbsenceProofCommand(
          argv,
          load,
          async () => JSON.stringify(input),
          files,
        ),
      );
    const planned = await command([
      "--file",
      "/private/ids.json",
      "--plan-out",
      "/private/plan.json",
    ]);
    expect(planned).toMatchObject({ status: "planned", contacts: 6 });
    expect(planned.planHash).toBe(
      planFileHash(saved.get("/private/plan.json")!),
    );
    const written = await command([
      "--write",
      "--plan",
      "/private/plan.json",
      "--expect-plan-hash",
      planned.planHash!,
      "--approval",
      "desk-fixture",
    ]);
    expect(written).toMatchObject({
      status: "written",
      writes: { written: 2 },
    });
    expect(w.kitFetch).toHaveBeenCalledTimes(1);
    for (const result of [planned, written])
      for (const id of [...ids, "example.test", "/private"])
        expect(JSON.stringify(result)).not.toContain(`"${id}`);
    expect(
      await command(
        ["--file", "/private/ids.json", "--plan-out", "/private/other.json"],
        { contactIds: ["a", "a"] },
      ),
    ).toMatchObject({ status: "refused", reason: "input-invalid" });
    expect(
      await command([
        "--file",
        "/private/ids.json",
        "--plan-out",
        "/private/plan.json",
      ]),
    ).toMatchObject({ status: "refused", reason: "plan-unwritable" });
    expect(await command(["--file", "/private/ids.json"])).toMatchObject({
      status: "refused",
      reason: "arguments-invalid",
    });
    expect(
      await command([
        "--write",
        "--plan",
        "/private/plan.json",
        "--expect-plan-hash",
        "a".repeat(64),
      ]),
    ).toMatchObject({ status: "refused", reason: "approval-required" });
    // The re-scanning write is gone.
    expect(
      await command([
        "--file",
        "/private/ids.json",
        "--write",
        "--approval",
        "desk-fixture",
        "--plan-hash",
        "a".repeat(64),
      ]),
    ).toMatchObject({ status: "refused", reason: "arguments-invalid" });
  });
});

describe("Kit absence recheck", () => {
  const kit = (
    handler: (url: URL) => Response | Promise<Response>,
    nowMs = () => 0,
  ) => {
    const calls: URL[] = [];
    const kitFetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url);
      return handler(url);
    });
    const sleep = vi.fn(async () => {});
    return {
      calls,
      sleep,
      recheck: createKitAbsenceRecheck({
        apiKey: "fixture-kit-key",
        fetch: kitFetch as unknown as typeof fetch,
        nowMs,
        sleep,
      }),
    };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it("reads one subscriber's state", async () => {
    const { recheck, calls } = kit(() =>
      json({ subscriber: { id: 6, state: "cancelled", email_address: "x" } }),
    );
    expect(await recheck.kitSubscriberState("6")).toBe("cancelled");
    expect(calls[0]?.pathname).toBe("/v4/subscribers/6");
    await expect(recheck.kitSubscriberState("7")).rejects.toMatchObject({
      reason: "recheck-unavailable",
    });
  });

  it("reads the adds since the snapshot once a minute, not once per reader", async () => {
    let now = 0;
    const { recheck, calls } = kit(
      () =>
        json({
          subscribers: [{ id: 7 }],
          pagination: { has_next_page: false, end_cursor: null },
        }),
      () => now,
    );
    expect(await recheck.oldSequenceAddedSince("7", start)).toBe(true);
    expect(await recheck.oldSequenceAddedSince("2", start)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get("status")).toBe("all");
    expect(calls[0]?.searchParams.get("added_after")).toBe("2026-10-28");
    now += 61_000;
    await recheck.oldSequenceAddedSince("2", start);
    expect(calls).toHaveLength(2);
  });

  it("never reuses a failed or capped add list", async () => {
    let status = 404;
    const { recheck, calls } = kit(() =>
      status === 200
        ? json({
            subscribers: [],
            pagination: { has_next_page: false, end_cursor: null },
          })
        : json({}, status),
    );
    await expect(
      recheck.oldSequenceAddedSince("2", start),
    ).rejects.toMatchObject({ reason: "recheck-unavailable" });
    status = 200;
    expect(await recheck.oldSequenceAddedSince("2", start)).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("retries a 429 after Retry-After, at most five times", async () => {
    let attempts = 0;
    const { recheck, sleep } = kit(() => {
      attempts += 1;
      return attempts < 3
        ? new Response("{}", { status: 429, headers: { "retry-after": "2" } })
        : json({ subscriber: { id: 2, state: "active" } });
    });
    expect(await recheck.kitSubscriberState("2")).toBe("active");
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(attempts).toBe(3);
  });

  it("widens added_after by a day", () => {
    expect(addedAfterDate("2026-10-29T00:30:00.000Z")).toBe("2026-10-28");
  });
});
