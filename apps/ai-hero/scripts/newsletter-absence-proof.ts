import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { z } from "zod";
import { normalizeContactEvent } from "../src/lib/subscriber-marketing/normalize-contact-event";
import {
  NEWSLETTER_PROTECTED_COHORT,
  OLD_NEWSLETTER_EXIT_CONFIRMED,
  OLD_NEWSLETTER_REFERENCE,
} from "../src/lib/subscriber-marketing/old-newsletter-exit";
import type { ContactRecord } from "../src/lib/subscriber-marketing/types";
import {
  MAX_PROOF_AGE_AT_WRITE_MS,
  MAX_SCAN_AGE_MS,
  OLD_SEQUENCE_ID,
  RecoveryRefused,
  type MembershipScan,
  type RecoveryRuntime,
  type RecoverySnapshot,
} from "./held-exit-recover";

/** Batch absence proof for blocked shadow-newsletter readers (Ruling A).
 * A reader absent from a complete, fresh `status=all` GET scan of 2625552 was
 * never enrolled there, removed or not, so an exit receipt dated at scan start
 * is true. Any membership stays blocked. The only write is that receipt;
 * drovr's own re-ask or redrive re-runs personalize, so nothing is notified.
 * The dry run pins its snapshot in a private plan file; the write reads that
 * plan, never re-scans, and re-checks each absent reader before its receipt.
 * dry run: inspecting -> refused | planned (plan file, sha256 = planHash).
 * write: verifying plan -> refused | writing -> written | partial. */
export type AbsenceProofRuntime = Pick<
  RecoveryRuntime,
  | "approvalScope"
  | "findContactById"
  | "inspect"
  | "scan"
  | "persist"
  | "currentMembership"
  | "now"
> & { recheck?: AbsenceRecheckRuntime };

/** Write-time reads for one planned reader. Each throws when it cannot answer. */
export type AbsenceRecheckRuntime = {
  /** A local stop event, or a stop state on drovr's contact-directory actor. */
  drovrStopped: (contactId: string) => Promise<boolean>;
  /** The Kit subscriber's state. Anything but `active` skips the reader. */
  kitSubscriberState: (subscriberId: string) => Promise<string>;
  /** Listed in 2625552 with an add at or after `since`, in any status. */
  oldSequenceAddedSince: (
    subscriberId: string,
    since: string,
  ) => Promise<boolean>;
};

export const MAX_ABSENCE_PROOF_CONTACTS = 10_000;
/** Database reads and writes in flight at once; the Kit scan is one shared GET pass. */
export const ABSENCE_PROOF_DB_CONCURRENCY = 8;

export const ABSENCE_PROOF_CLASSES = [
  "contact-missing",
  "already-proven",
  "protected-cohort",
  "identity-unproven",
  "old-sequence-member",
  "absent",
] as const;
export type AbsenceProofClass = (typeof ABSENCE_PROOF_CLASSES)[number];

export const ABSENCE_WRITE_OUTCOMES = [
  "written",
  "written-unverified",
  "skipped",
  "failed",
] as const;
export type AbsenceWriteOutcome = (typeof ABSENCE_WRITE_OUTCOMES)[number];

/** Why a planned `absent` reader got no receipt. Every skip is counted. */
export const ABSENCE_SKIP_REASONS = [
  "already-proven",
  "snapshot-changed",
  "drovr-stopped",
  "kit-unsubscribed",
  "old-sequence-member",
  "recheck-unavailable",
] as const;
export type AbsenceSkipReason = (typeof ABSENCE_SKIP_REASONS)[number];

export type AbsenceProofArgs =
  | { mode: "dry-run"; contactIds: string[] }
  | {
      mode: "write";
      /** The plan file's exact text, hashed as read. */
      plan: string;
      approval: string;
      expectPlanHash: string;
    };

export type AbsenceProofEnvelope = {
  version: 1;
  operation: "newsletter-absence-proof";
  mode: AbsenceProofArgs["mode"];
  status: "refused" | "planned" | "written" | "partial";
  reason: string | null;
  /** sha256 of the plan file: the snapshot hash the write must name. */
  planHash: string | null;
  contacts: number;
  classes: Record<AbsenceProofClass, number>;
  writes: Record<AbsenceWriteOutcome, number>;
  skipped: Record<AbsenceSkipReason, number>;
  scan: Omit<MembershipScan, "membership"> | null;
};

type Decision = {
  contactId: string;
  class: AbsenceProofClass;
  snapshot: string | null;
  identity: RecoverySnapshot["identities"][number] | null;
};

const contactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,254}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const subscriberIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
export const absenceProofInputSchema = z
  .object({ contactIds: z.array(contactIdSchema).min(1) })
  .strict()
  .refine(
    (input) =>
      input.contactIds.length <= MAX_ABSENCE_PROOF_CONTACTS &&
      new Set(input.contactIds).size === input.contactIds.length,
  );

const planScanSchema = z
  .object({
    sequenceId: z.literal(OLD_SEQUENCE_ID),
    complete: z.literal(true),
    pages: z.number().int().positive(),
    subscribers: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    fingerprint: sha256Schema,
  })
  .strict();
const planDecisionSchema = z
  .object({
    contactId: contactIdSchema,
    class: z.enum(ABSENCE_PROOF_CLASSES),
    snapshot: sha256Schema.nullable(),
    identityId: z.string().min(1).max(255).nullable(),
    subscriberId: subscriberIdSchema.nullable(),
  })
  .strict();
/** The private snapshot. Ids only: no emails, names or Kit member lists. */
export const absencePlanSchema = z
  .object({
    version: z.literal(2),
    operation: z.literal("newsletter-absence-proof"),
    approvalScope: z.string().min(1),
    sequenceId: z.literal(OLD_SEQUENCE_ID),
    scan: planScanSchema.nullable(),
    classes: z.record(
      z.enum(ABSENCE_PROOF_CLASSES),
      z.number().int().nonnegative(),
    ),
    decisions: z
      .array(planDecisionSchema)
      .min(1)
      .max(MAX_ABSENCE_PROOF_CONTACTS),
  })
  .strict()
  .refine(
    (plan) =>
      new Set(plan.decisions.map((decision) => decision.contactId)).size ===
        plan.decisions.length &&
      ABSENCE_PROOF_CLASSES.every(
        (value) =>
          plan.classes[value] ===
          plan.decisions.filter((decision) => decision.class === value).length,
      ) &&
      plan.decisions.every((decision) =>
        decision.class === "absent"
          ? plan.scan !== null &&
            decision.snapshot !== null &&
            decision.identityId !== null &&
            decision.subscriberId !== null
          : decision.identityId === null && decision.subscriberId === null,
      ),
  );
export type AbsencePlan = z.infer<typeof absencePlanSchema>;
type PlanDecision = AbsencePlan["decisions"][number];

const zeroes = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

const sha256 = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

/** The plan hash is the sha256 of the plan file's exact bytes. */
export const planFileHash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** The gate-relevant state only: Kit identities and newsletter history.
 * A contact profile edit between plan and write does not skip the reader. */
const snapshotDigest = (state: RecoverySnapshot) =>
  sha256({
    identities: [...state.identities].sort((a, b) => a.id.localeCompare(b.id)),
    history: [...state.history].sort((a, b) => a.id.localeCompare(b.id)),
  });

const boundary = <A>(reason: string, action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (error) =>
      error instanceof RecoveryRefused
        ? error
        : new RecoveryRefused({ reason }),
  });

function freshAbsence(scan: MembershipScan, now: string) {
  const start = Date.parse(scan.startedAt),
    end = Date.parse(scan.completedAt),
    current = Date.parse(now);
  return (
    scan.membership === "absent" &&
    scan.complete &&
    scan.pages > 0 &&
    scan.sequenceId === OLD_SEQUENCE_ID &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    Number.isFinite(current) &&
    start <= end &&
    end <= current &&
    end - start <= MAX_SCAN_AGE_MS &&
    current - end <= MAX_PROOF_AGE_AT_WRITE_MS
  );
}

const provenIdentity = (
  contactId: string,
  identities: RecoverySnapshot["identities"],
) => {
  const identity = identities[0];
  return identities.length === 1 &&
    identity &&
    identity.contactId === contactId &&
    /^[1-9]\d*$/.test(identity.externalId) &&
    Number.isSafeInteger(Number(identity.externalId))
    ? identity
    : null;
};

type Local = Decision | (Omit<Decision, "class"> & { class: "needs-scan" });

/** Local reads only, so the shared scan's 15-minute proof age is not spent on them. */
function classifyLocal(contactId: string, runtime: AbsenceProofRuntime) {
  return Effect.gen(function* () {
    const contact = yield* boundary("database-unavailable", () =>
      runtime.findContactById(contactId),
    );
    if (!contact || contact.id !== contactId)
      return {
        contactId,
        class: "contact-missing",
        snapshot: null,
        identity: null,
      } satisfies Local;
    const [membership, state] = yield* Effect.all([
      boundary("database-unavailable", () =>
        runtime.currentMembership(contactId),
      ),
      boundary("database-unavailable", () => runtime.inspect(contactId)),
    ]);
    const snapshot = snapshotDigest(state);
    const identity = provenIdentity(contactId, state.identities);
    const value: Local["class"] =
      membership === "exited" || membership === "absent"
        ? "already-proven"
        : state.history.some(
              (event) =>
                event.contactId === contactId &&
                event.eventType === NEWSLETTER_PROTECTED_COHORT,
            )
          ? "protected-cohort"
          : identity
            ? "needs-scan"
            : "identity-unproven";
    return {
      contactId,
      class: value,
      snapshot,
      identity: value === "needs-scan" ? identity : null,
    } satisfies Local;
  });
}

function classifyScanned(local: Local, runtime: AbsenceProofRuntime) {
  return Effect.gen(function* () {
    if (local.class !== "needs-scan" || !local.identity)
      return { decision: local as Decision, scan: null };
    const externalId = local.identity.externalId;
    const scan = yield* boundary("provider-unavailable", () =>
      runtime.scan(externalId),
    );
    if (scan.membership === "present")
      return {
        decision: {
          ...local,
          class: "old-sequence-member",
          identity: null,
        } as Decision,
        scan,
      };
    if (!freshAbsence(scan, runtime.now()))
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "provider-unavailable" }),
      );
    return { decision: { ...local, class: "absent" } as Decision, scan };
  });
}

/** One canonical line, so the same snapshot always hashes the same. */
export const serializePlan = (plan: AbsencePlan) =>
  `${JSON.stringify(canonical(plan))}\n`;

const emptyEnvelope = (
  mode: AbsenceProofArgs["mode"],
  contacts: number,
): AbsenceProofEnvelope => ({
  version: 1,
  operation: "newsletter-absence-proof",
  mode,
  status: "refused",
  reason: null,
  planHash: null,
  contacts,
  classes: zeroes(ABSENCE_PROOF_CLASSES),
  writes: zeroes(ABSENCE_WRITE_OUTCOMES),
  skipped: zeroes(ABSENCE_SKIP_REASONS),
  scan: null,
});

/** Dry run: one shared scan classifies every reader, and the plan pins the result.
 * The plan text is returned for the command to save; stdout never carries it. */
export function planNewsletterAbsenceProof(
  contactIds: readonly string[],
  runtime: AbsenceProofRuntime,
): Effect.Effect<{ envelope: AbsenceProofEnvelope; plan: string | null }> {
  const envelope = emptyEnvelope("dry-run", contactIds.length);
  return Effect.gen(function* () {
    const locals = yield* Effect.forEach(
      contactIds,
      (contactId) => classifyLocal(contactId, runtime),
      { concurrency: ABSENCE_PROOF_DB_CONCURRENCY },
    );
    const decisions: Decision[] = [];
    let scan: MembershipScan | null = null;
    for (const local of locals) {
      const classified = yield* classifyScanned(local, runtime);
      decisions.push(classified.decision);
      envelope.classes[classified.decision.class] += 1;
      if (classified.scan) {
        if (scan && classified.scan.fingerprint !== scan.fingerprint)
          return yield* Effect.fail(
            new RecoveryRefused({ reason: "provider-unavailable" }),
          );
        scan = classified.scan;
      }
    }
    const summary = scan
      ? {
          sequenceId: scan.sequenceId,
          complete: scan.complete,
          pages: scan.pages,
          subscribers: scan.subscribers,
          startedAt: scan.startedAt,
          completedAt: scan.completedAt,
          fingerprint:
            scan.fingerprint ??
            sha256({ ...scan, membership: undefined, fingerprint: undefined }),
        }
      : null;
    envelope.scan = summary;
    const plan = absencePlanSchema.safeParse({
      version: 2,
      operation: "newsletter-absence-proof",
      approvalScope: runtime.approvalScope,
      sequenceId: OLD_SEQUENCE_ID,
      scan: summary,
      classes: envelope.classes,
      decisions: [...decisions]
        .sort((a, b) => a.contactId.localeCompare(b.contactId))
        .map((decision) => ({
          contactId: decision.contactId,
          class: decision.class,
          snapshot: decision.snapshot,
          identityId:
            decision.class === "absent"
              ? (decision.identity?.id ?? null)
              : null,
          subscriberId:
            decision.class === "absent"
              ? (decision.identity?.externalId ?? null)
              : null,
        })),
    });
    if (!plan.success)
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "plan-invalid" }),
      );
    const text = serializePlan(plan.data);
    envelope.planHash = planFileHash(text);
    envelope.status = "planned";
    return { envelope, plan: text };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        envelope: {
          ...envelope,
          status: "refused" as const,
          reason: error.reason,
        },
        plan: null,
      }),
    ),
  );
}

type WriteResult = "written" | "written-unverified" | AbsenceSkipReason;

/** Dry run classifies and pins; write consumes the pinned plan's `absent` readers only. */
export function runNewsletterAbsenceProof(
  args: AbsenceProofArgs,
  runtime: AbsenceProofRuntime,
): Effect.Effect<AbsenceProofEnvelope> {
  if (args.mode === "dry-run")
    return planNewsletterAbsenceProof(args.contactIds, runtime).pipe(
      Effect.map(({ envelope }) => envelope),
    );
  const envelope = emptyEnvelope("write", 0);
  return Effect.gen(function* () {
    if (!args.approval.trim())
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "approval-required" }),
      );
    const planHash = planFileHash(args.plan);
    if (planHash !== args.expectPlanHash)
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "plan-hash-mismatch" }),
      );
    const decoded = yield* Effect.try({
      try: () => absencePlanSchema.parse(JSON.parse(args.plan)),
      catch: () => new RecoveryRefused({ reason: "plan-invalid" }),
    });
    // Another database, Kit account or deployment would get receipts the plan never saw.
    if (decoded.approvalScope !== runtime.approvalScope)
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "plan-scope-mismatch" }),
      );
    const recheck = runtime.recheck;
    if (!recheck)
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "runtime-unavailable" }),
      );
    envelope.planHash = planHash;
    envelope.contacts = decoded.decisions.length;
    envelope.classes = { ...decoded.classes };
    envelope.scan = decoded.scan;
    const scan = decoded.scan;
    // Only the plan's own absent readers, never anyone the runtime can see.
    const absent = decoded.decisions.filter(
      (decision) => decision.class === "absent",
    );
    if (absent.length > 0 && !scan)
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "plan-invalid" }),
      );
    const context = {
      approval: args.approval,
      planHash,
      runtime,
      recheck,
    };
    yield* Effect.forEach(
      absent,
      (decision) =>
        writeOne(decision, scan!, context).pipe(
          Effect.map((result): WriteResult | "failed" => result),
          Effect.catch((error) =>
            Effect.sync(() => {
              envelope.reason ??= error.reason;
              return "failed" as const;
            }),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (
                result === "written" ||
                result === "written-unverified" ||
                result === "failed"
              )
                envelope.writes[result] += 1;
              else {
                envelope.writes.skipped += 1;
                envelope.skipped[result] += 1;
              }
              if (result === "written-unverified")
                envelope.reason ??= "receipt-not-current";
              if (result === "recheck-unavailable")
                envelope.reason ??= "recheck-unavailable";
            }),
          ),
        ),
      { concurrency: ABSENCE_PROOF_DB_CONCURRENCY, discard: true },
    );
    envelope.status =
      envelope.writes.written === absent.length ? "written" : "partial";
    return envelope;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ...envelope,
        status: "refused" as const,
        reason: error.reason,
      }),
    ),
  );
}

/** The external rechecks, after the local ones pass. A read that fails skips the reader. */
function recheckExternal(
  decision: PlanDecision,
  since: string,
  recheck: AbsenceRecheckRuntime,
) {
  const read = <A>(action: () => Promise<A>) =>
    boundary("recheck-unavailable", action);
  return Effect.gen(function* () {
    if (yield* read(() => recheck.drovrStopped(decision.contactId)))
      return "drovr-stopped" as const;
    const subscriberId = decision.subscriberId!;
    if (
      (yield* read(() => recheck.kitSubscriberState(subscriberId))) !== "active"
    )
      return "kit-unsubscribed" as const;
    if (yield* read(() => recheck.oldSequenceAddedSince(subscriberId, since)))
      return "old-sequence-member" as const;
    return null;
  }).pipe(Effect.catch(() => Effect.succeed("recheck-unavailable" as const)));
}

function writeOne(
  decision: PlanDecision,
  scan: NonNullable<AbsencePlan["scan"]>,
  context: {
    approval: string;
    planHash: string;
    runtime: AbsenceProofRuntime;
    recheck: AbsenceRecheckRuntime;
  },
) {
  const { runtime } = context;
  return Effect.gen(function* () {
    const contact: ContactRecord | undefined = yield* boundary(
      "database-unavailable",
      () => runtime.findContactById(decision.contactId),
    );
    if (!contact || contact.id !== decision.contactId)
      return "snapshot-changed" as const;
    const [membership, state] = yield* Effect.all([
      boundary("database-unavailable", () =>
        runtime.currentMembership(contact.id),
      ),
      boundary("database-unavailable", () => runtime.inspect(contact.id)),
    ]);
    if (membership === "exited" || membership === "absent")
      return "already-proven" as const;
    const identity = provenIdentity(contact.id, state.identities);
    if (
      !identity ||
      identity.id !== decision.identityId ||
      identity.externalId !== decision.subscriberId ||
      snapshotDigest(state) !== decision.snapshot
    )
      return "snapshot-changed" as const;
    const skip = yield* recheckExternal(
      decision,
      scan.startedAt,
      context.recheck,
    );
    if (skip) return skip;
    const recheckedAt = runtime.now();
    const normalized = normalizeContactEvent({
      provider: "kit",
      externalId: identity.externalId,
      providerEventId: `sequence:2625552:absence-scan:${scan.fingerprint}`,
      eventType: OLD_NEWSLETTER_EXIT_CONFIRMED,
      occurredAt: scan.startedAt,
      message: "Old newsletter absence verified by operator batch GET scan",
      privacyLevel: "internal",
    });
    const record = {
      ...normalized,
      contactId: contact.id,
      providerIdentityId: identity.id,
      providerReference: OLD_NEWSLETTER_REFERENCE,
      createdAt: recheckedAt,
      payloadSummary: {
        ...normalized.payloadSummary,
        summary: JSON.stringify({
          operation: "newsletter-absence-proof",
          proofKind: "absence-scan",
          approval: context.approval,
          planHash: context.planHash,
          scan,
          recheckedAt,
        }),
      },
    };
    const receipt = yield* boundary("database-unavailable", () =>
      runtime.persist(record),
    );
    if (
      receipt.contactId !== contact.id ||
      receipt.eventType !== OLD_NEWSLETTER_EXIT_CONFIRMED ||
      receipt.providerReference !== OLD_NEWSLETTER_REFERENCE
    )
      return "written-unverified" as const;
    const after = yield* boundary("database-unavailable", () =>
      runtime.currentMembership(contact.id),
    ).pipe(Effect.orElseSucceed(() => "unknown" as const));
    return after === "exited"
      ? ("written" as const)
      : ("written-unverified" as const);
  });
}

export type ParsedAbsenceProofArgs =
  | { mode: "dry-run"; file: string; planOut: string }
  | {
      mode: "write";
      plan: string;
      approval: string;
      expectPlanHash: string;
    };

export function parseAbsenceProofArgs(
  argv: readonly string[],
): ParsedAbsenceProofArgs {
  const invalid = () => new RecoveryRefused({ reason: "arguments-invalid" });
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag || flags.has(flag)) throw invalid();
    if (flag === "--write") {
      flags.set(flag, true);
      continue;
    }
    if (
      ![
        "--file",
        "--plan-out",
        "--plan",
        "--expect-plan-hash",
        "--approval",
      ].includes(flag)
    )
      throw invalid();
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw invalid();
    flags.set(flag, value);
  }
  const value = (flag: string) => {
    const found = flags.get(flag);
    return typeof found === "string" ? found : undefined;
  };
  if (flags.has("--write")) {
    if (flags.has("--file") || flags.has("--plan-out")) throw invalid();
    const approval = value("--approval");
    if (!approval?.trim())
      throw new RecoveryRefused({ reason: "approval-required" });
    const plan = value("--plan");
    const expectPlanHash = value("--expect-plan-hash");
    if (!plan || !expectPlanHash || !/^[a-f0-9]{64}$/.test(expectPlanHash))
      throw invalid();
    return { mode: "write", plan, approval: approval.trim(), expectPlanHash };
  }
  const file = value("--file");
  const planOut = value("--plan-out");
  // A plan hash with no saved plan could be approved but never written.
  if (
    !file ||
    !planOut ||
    flags.has("--approval") ||
    flags.has("--plan") ||
    flags.has("--expect-plan-hash")
  )
    throw invalid();
  return { mode: "dry-run", file, planOut };
}

export type AbsenceProofRuntimeLoader = (
  mode: AbsenceProofArgs["mode"],
) => Promise<{ runtime: AbsenceProofRuntime; close: () => Promise<void> }>;

/** Private plan file I/O. Refusals name the file problem, never the path. */
export type AbsencePlanFiles = {
  /** Before the scan: the path must be new, in an existing directory. */
  prepare: (path: string) => Promise<void>;
  /** Create the file 0600, never overwriting anything. */
  write: (path: string, text: string) => Promise<void>;
  /** Only a regular, operator-owned, 0600 file is read. */
  read: (path: string) => Promise<string>;
};

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

export const nodePlanFiles: AbsencePlanFiles = {
  prepare: async (path) => {
    const existing = await lstat(path).catch((error) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (existing) throw new RecoveryRefused({ reason: "plan-exists" });
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new RecoveryRefused({ reason: "plan-unwritable" });
  },
  write: async (path, text) => {
    const file = await open(path, "wx", 0o600).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new RecoveryRefused({ reason: "plan-exists" });
      throw error;
    });
    try {
      // The umask can only narrow the create mode; set it exactly anyway.
      await file.chmod(0o600);
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  },
  read: async (path) => {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid()) ||
      (info.mode & 0o777) !== 0o600
    )
      throw new RecoveryRefused({ reason: "plan-unsafe" });
    return readFile(path, "utf8");
  },
};

/** Reads the private id or plan file, never prints an id, and returns counts only. */
export function runNewsletterAbsenceProofCommand(
  argv: readonly string[],
  load: AbsenceProofRuntimeLoader,
  readInput: (path: string) => Promise<string> = (path) =>
    readFile(path, "utf8"),
  planFiles: AbsencePlanFiles = nodePlanFiles,
) {
  const refused = (reason: string): AbsenceProofEnvelope => ({
    ...emptyEnvelope(argv.includes("--write") ? "write" : "dry-run", 0),
    reason,
  });
  const withRuntime = <A>(
    mode: AbsenceProofArgs["mode"],
    use: (runtime: AbsenceProofRuntime) => Effect.Effect<A>,
  ) =>
    Effect.acquireUseRelease(
      boundary("runtime-unavailable", () => load(mode)),
      ({ runtime }) => use(runtime),
      ({ close }) =>
        boundary("runtime-close-failed", close).pipe(
          Effect.catch(() => Effect.void),
        ),
    );
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseAbsenceProofArgs(argv),
      catch: (error) =>
        error instanceof RecoveryRefused
          ? error
          : new RecoveryRefused({ reason: "arguments-invalid" }),
    });
    if (parsed.mode === "write") {
      const plan = yield* boundary("plan-unreadable", () =>
        planFiles.read(parsed.plan),
      );
      return yield* withRuntime("write", (runtime) =>
        runNewsletterAbsenceProof(
          {
            mode: "write",
            plan,
            approval: parsed.approval,
            expectPlanHash: parsed.expectPlanHash,
          },
          runtime,
        ),
      );
    }
    const raw = yield* boundary("input-unreadable", () =>
      readInput(parsed.file),
    );
    const input = yield* Effect.try({
      try: () => absenceProofInputSchema.parse(JSON.parse(raw)),
      catch: () => new RecoveryRefused({ reason: "input-invalid" }),
    });
    const planOut = parsed.planOut;
    // Refuse a bad path before a half-hour scan, not after it.
    yield* boundary("plan-unwritable", () => planFiles.prepare(planOut));
    const { envelope, plan } = yield* withRuntime("dry-run", (runtime) =>
      planNewsletterAbsenceProof(input.contactIds, runtime),
    );
    if (plan)
      yield* boundary("plan-unwritable", () => planFiles.write(planOut, plan));
    return envelope;
  }).pipe(
    Effect.catch((error) => Effect.succeed(refused(error.reason))),
    Effect.catchCause(() => Effect.succeed(refused("internal-error"))),
  );
}

async function main() {
  const result = await Effect.runPromise(
    runNewsletterAbsenceProofCommand(process.argv.slice(2), async (mode) => {
      const { createProductionAbsenceProofRuntime } =
        await import("./newsletter-absence-proof-runtime");
      return createProductionAbsenceProofRuntime(mode);
    }),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "refused" ? 1 : 0;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  void main();
