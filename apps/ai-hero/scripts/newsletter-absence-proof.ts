import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
 * inspecting -> refused | planned; planned + WRITE -> writing -> written | partial. */
export type AbsenceProofRuntime = Pick<
  RecoveryRuntime,
  | "approvalScope"
  | "findContactById"
  | "inspect"
  | "scan"
  | "persist"
  | "currentMembership"
  | "now"
>;

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
  "snapshot-changed",
  "already-proven",
  "proof-expired",
  "written-unverified",
  "failed",
] as const;
export type AbsenceWriteOutcome = (typeof ABSENCE_WRITE_OUTCOMES)[number];

export type AbsenceProofArgs =
  | { mode: "dry-run"; contactIds: string[] }
  | { mode: "write"; contactIds: string[]; approval: string; planHash: string };

export type AbsenceProofEnvelope = {
  version: 1;
  operation: "newsletter-absence-proof";
  mode: AbsenceProofArgs["mode"];
  status: "refused" | "planned" | "written" | "partial";
  reason: string | null;
  planHash: string | null;
  contacts: number;
  classes: Record<AbsenceProofClass, number>;
  writes: Record<AbsenceWriteOutcome, number>;
  scan: Omit<MembershipScan, "membership"> | null;
};

type Decision = {
  contactId: string;
  class: AbsenceProofClass;
  snapshot: string | null;
  identity: RecoverySnapshot["identities"][number] | null;
};

const contactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,254}$/);
export const absenceProofInputSchema = z
  .object({ contactIds: z.array(contactIdSchema).min(1) })
  .strict()
  .refine(
    (input) =>
      input.contactIds.length <= MAX_ABSENCE_PROOF_CONTACTS &&
      new Set(input.contactIds).size === input.contactIds.length,
  );

const zeroes = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

const sha256 = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

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

const snapshotDigest = (contact: ContactRecord, state: RecoverySnapshot) =>
  sha256({
    contact,
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
    const snapshot = snapshotDigest(contact, state);
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
        decision: { ...local, class: "old-sequence-member" } as Decision,
        scan,
      };
    if (!freshAbsence(scan, runtime.now()))
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "provider-unavailable" }),
      );
    return { decision: { ...local, class: "absent" } as Decision, scan };
  });
}

const planHashOf = (
  approvalScope: string,
  scan: MembershipScan | null,
  decisions: Decision[],
) =>
  sha256({
    version: 1,
    operation: "newsletter-absence-proof",
    approvalScope,
    sequenceId: OLD_SEQUENCE_ID,
    scanFingerprint: scan?.fingerprint ?? (scan ? sha256(scan) : null),
    decisions: [...decisions]
      .sort((a, b) => a.contactId.localeCompare(b.contactId))
      .map(({ contactId, class: value, snapshot }) => [
        contactId,
        value,
        snapshot,
      ]),
  });

/** Dry run counts every class; write re-checks each absent reader just before its own receipt. */
export function runNewsletterAbsenceProof(
  args: AbsenceProofArgs,
  runtime: AbsenceProofRuntime,
): Effect.Effect<AbsenceProofEnvelope> {
  const envelope: AbsenceProofEnvelope = {
    version: 1,
    operation: "newsletter-absence-proof",
    mode: args.mode,
    status: "refused",
    reason: null,
    planHash: null,
    contacts: args.contactIds.length,
    classes: zeroes(ABSENCE_PROOF_CLASSES),
    writes: zeroes(ABSENCE_WRITE_OUTCOMES),
    scan: null,
  };
  return Effect.gen(function* () {
    if (args.mode === "write" && !args.approval.trim())
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "approval-required" }),
      );
    const locals = yield* Effect.forEach(
      args.contactIds,
      (contactId) => classifyLocal(contactId, runtime),
      { concurrency: ABSENCE_PROOF_DB_CONCURRENCY },
    );
    const decisions: Decision[] = [];
    let scan: MembershipScan | null = null;
    let absenceProof: MembershipScan | null = null;
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
        if (classified.decision.class === "absent")
          absenceProof = classified.scan;
      }
    }
    if (scan) {
      const { membership: _membership, ...summary } = scan;
      envelope.scan = summary;
    }
    envelope.planHash = planHashOf(runtime.approvalScope, scan, decisions);
    if (args.mode === "dry-run") {
      envelope.status = "planned";
      return envelope;
    }
    if (args.planHash !== envelope.planHash)
      return yield* Effect.fail(
        new RecoveryRefused({ reason: "plan-hash-mismatch" }),
      );
    const approval = args.approval;
    const planHash = envelope.planHash;
    const absent = decisions.filter((decision) => decision.class === "absent");
    const proof = absenceProof;
    yield* Effect.forEach(
      absent,
      (decision) =>
        (proof && freshAbsence(proof, runtime.now())
          ? writeOne(decision, proof, { approval, planHash, runtime })
          : Effect.succeed("proof-expired" as const)
        ).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              envelope.reason ??= error.reason;
              return "failed" as const;
            }),
          ),
          Effect.tap((outcome) =>
            Effect.sync(() => {
              envelope.writes[outcome] += 1;
              if (outcome === "written-unverified")
                envelope.reason ??= "receipt-not-current";
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

function writeOne(
  decision: Decision,
  scan: MembershipScan,
  context: {
    approval: string;
    planHash: string;
    runtime: AbsenceProofRuntime;
  },
) {
  const { runtime } = context;
  return Effect.gen(function* () {
    const identity = decision.identity;
    const contact = yield* boundary("database-unavailable", () =>
      runtime.findContactById(decision.contactId),
    );
    if (!contact || !identity) return "snapshot-changed" as const;
    const [membership, state] = yield* Effect.all([
      boundary("database-unavailable", () =>
        runtime.currentMembership(contact.id),
      ),
      boundary("database-unavailable", () => runtime.inspect(contact.id)),
    ]);
    if (membership === "exited" || membership === "absent")
      return "already-proven" as const;
    if (snapshotDigest(contact, state) !== decision.snapshot)
      return "snapshot-changed" as const;
    const normalized = normalizeContactEvent({
      provider: "kit",
      externalId: identity.externalId,
      providerEventId: `sequence:2625552:absence-scan:${scan.fingerprint ?? sha256(scan)}`,
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
      createdAt: runtime.now(),
      payloadSummary: {
        ...normalized.payloadSummary,
        summary: JSON.stringify({
          operation: "newsletter-absence-proof",
          proofKind: "absence-scan",
          approval: context.approval,
          planHash: context.planHash,
          scan,
        }),
      },
    };
    if (!freshAbsence(scan, runtime.now())) return "proof-expired" as const;
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

export function parseAbsenceProofArgs(argv: readonly string[]) {
  const invalid = () => new RecoveryRefused({ reason: "arguments-invalid" });
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag || flags.has(flag)) throw invalid();
    if (flag === "--write") {
      flags.set(flag, true);
      continue;
    }
    if (!["--file", "--approval", "--plan-hash"].includes(flag))
      throw invalid();
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw invalid();
    flags.set(flag, value);
  }
  const file = flags.get("--file");
  if (typeof file !== "string") throw invalid();
  const approval = flags.get("--approval");
  const planHash = flags.get("--plan-hash");
  if (flags.has("--write")) {
    if (typeof approval !== "string" || !approval.trim())
      throw new RecoveryRefused({ reason: "approval-required" });
    if (typeof planHash !== "string" || !/^[a-f0-9]{64}$/.test(planHash))
      throw invalid();
    return {
      file,
      mode: "write" as const,
      approval: approval.trim(),
      planHash,
    };
  }
  if (approval !== undefined || planHash !== undefined) throw invalid();
  return { file, mode: "dry-run" as const };
}

export type AbsenceProofRuntimeLoader = (
  mode: AbsenceProofArgs["mode"],
) => Promise<{ runtime: AbsenceProofRuntime; close: () => Promise<void> }>;

/** Reads the private id file, never prints an id, and returns counts only. */
export function runNewsletterAbsenceProofCommand(
  argv: readonly string[],
  load: AbsenceProofRuntimeLoader,
  readInput: (path: string) => Promise<string> = (path) =>
    readFile(path, "utf8"),
) {
  const refused = (reason: string): AbsenceProofEnvelope => ({
    version: 1,
    operation: "newsletter-absence-proof",
    mode: argv.includes("--write") ? "write" : "dry-run",
    status: "refused",
    reason,
    planHash: null,
    contacts: 0,
    classes: zeroes(ABSENCE_PROOF_CLASSES),
    writes: zeroes(ABSENCE_WRITE_OUTCOMES),
    scan: null,
  });
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseAbsenceProofArgs(argv),
      catch: (error) =>
        error instanceof RecoveryRefused
          ? error
          : new RecoveryRefused({ reason: "arguments-invalid" }),
    });
    const raw = yield* boundary("input-unreadable", () =>
      readInput(parsed.file),
    );
    const input = yield* Effect.try({
      try: () => absenceProofInputSchema.parse(JSON.parse(raw)),
      catch: () => new RecoveryRefused({ reason: "input-invalid" }),
    });
    const args: AbsenceProofArgs =
      parsed.mode === "write"
        ? {
            mode: "write",
            contactIds: input.contactIds,
            approval: parsed.approval,
            planHash: parsed.planHash,
          }
        : { mode: "dry-run", contactIds: input.contactIds };
    return yield* Effect.acquireUseRelease(
      boundary("runtime-unavailable", () => load(args.mode)),
      ({ runtime }) => runNewsletterAbsenceProof(args, runtime),
      ({ close }) =>
        boundary("runtime-close-failed", close).pipe(
          Effect.catch(() => Effect.void),
        ),
    );
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
