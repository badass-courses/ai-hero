import { isSyntheticPrincipalId } from "@/lib/synthetic-principal";

import type { DrovrEmailDeliveryRead } from "./drovr-email-delivery";
import {
  mapDrovrShadowFact,
  type DrovrDeliveryOutcome,
  type DrovrShadowEvent,
} from "./drovr-shadow-emitter";
import type { ContactEventRecord } from "./types";

/**
 * The owner-without-birth guard (hawk row 110). An owner assignment is a
 * value-path contact's only authority birth; if its hand-off is lost (six
 * on 2026-09-27, before #326 awaited it) nothing else re-sends it, and the
 * contact never gets lesson one.
 *
 * Hourly, for skills-course owners assigned 1 h to 72 h ago, ask drovr
 * whether lesson one went out (`GET /email-delivery`). Only `not-started`
 * goes further, and only when `GET /contacts` answers 404
 * `contact-not-found` for the value-path journey (no actor snapshot) is
 * the birth lost. Then the original birth, exactly as the live dispatch
 * built it (same key), is posted once, and never again for that owner.
 *
 * Never re-posted: an actor that exists but sent nothing (logged), a stop
 * in ai-hero or on drovr's directory actor, a synthetic principal, an
 * unreadable answer, or an owner already re-posted once.
 */

export const OWNER_BIRTH_GUARD_REPOST_CAP = 25;
export const OWNER_BIRTH_GUARD_MIN_AGE_MS = 60 * 60 * 1000;
export const OWNER_BIRTH_GUARD_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const OWNER_BIRTH_GUARD_JOURNEY_ID = "value-path-skills-course" as const;
const DIRECTORY_JOURNEY_ID = "contact-directory";
const MAX_PAGES = 200;
const READS_IN_FLIGHT = 10;

/** A directory actor in any stop state: drovr's suppression is written. */
const STOPPED_DIRECTORY_STATE = /unsubscrib|bounce|complain|suppress|stop/i;

export type DrovrActorRead =
  | { ok: true; found: false }
  | { ok: true; found: true; stateName: string }
  | { ok: false; reason: string };

export type OwnerCursor = { occurredAt: string; id: string };

export type RepostOutcome = "accepted" | "suppressed" | "rejected";

export type OwnerBirthGuardPorts = {
  /** Skills-course owner assignments in [from, to], by (occurredAt, id). */
  scanOwners(args: {
    from: string;
    to: string;
    after?: OwnerCursor;
    limit: number;
  }): Promise<ContactEventRecord[]>;
  /** Contacts with an unsubscribe, bounce, or complaint ContactEvent. */
  stoppedContactIds(
    contactIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
  /** Ids of the owner events the guard already re-posted (its marker). */
  repostedOwnerEventIds(
    owners: readonly Pick<ContactEventRecord, "id" | "contactId">[],
  ): Promise<ReadonlySet<string>>;
  readDelivery(contactId: string): Promise<DrovrEmailDeliveryRead>;
  readActor(contactId: string, journeyId: string): Promise<DrovrActorRead>;
  /** One event to drovr; throws on a transient failure (the step retries). */
  post(event: DrovrShadowEvent): Promise<DrovrDeliveryOutcome>;
  /** The durable marker: this owner's birth was posted once, with this outcome. */
  recordRepost(
    owner: ContactEventRecord,
    outcome: RepostOutcome,
  ): Promise<void>;
  log: {
    info(event: string, fields: Record<string, unknown>): unknown;
    warn(event: string, fields: Record<string, unknown>): unknown;
  };
};

type Candidate = { owner: ContactEventRecord; birth: DrovrShadowEvent };

type PageCounts = {
  owners: number;
  skippedSynthetic: number;
  skippedStopped: number;
  skippedSuppressed: number;
  delivered: number;
  pending: number;
  notRouted: number;
  actorWithoutSend: number;
  repostNoEffect: number;
  unreadable: number;
  unmappable: number;
};

type PageResult = PageCounts & { candidates: Candidate[]; next?: OwnerCursor };

export type OwnerBirthGuardReceipt = PageCounts & {
  status: "checked";
  from: string;
  to: string;
  pages: number;
  candidates: number;
  reposted: number;
  suppressedOnPost: number;
  rejectedOnPost: number;
  capHit: boolean;
  overCap: number;
  /** Not every owner in the window was read: MAX_PAGES was reached. */
  truncated: boolean;
};

const zeroCounts = (): PageCounts => ({
  owners: 0,
  skippedSynthetic: 0,
  skippedStopped: 0,
  skippedSuppressed: 0,
  delivered: 0,
  pending: 0,
  notRouted: 0,
  actorWithoutSend: 0,
  repostNoEffect: 0,
  unreadable: 0,
  unmappable: 0,
});

async function logSafely(
  write: (event: string, fields: Record<string, unknown>) => unknown,
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    await write(event, fields);
  } catch {
    // Logging cannot change what the guard decided.
  }
}

async function mapInBatches<T, R>(
  items: readonly T[],
  size: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size)
    results.push(
      ...(await Promise.all(items.slice(start, start + size).map(operation))),
    );
  return results;
}

type Verdict =
  | { kind: "delivered" | "pending" | "notRouted" }
  | { kind: "unreadable"; reason: string }
  | { kind: "actorWithoutSend"; stateName: string }
  | { kind: "suppressed"; stateName: string }
  | { kind: "lost" };

async function judge(
  ports: OwnerBirthGuardPorts,
  contactId: string,
): Promise<Verdict> {
  const read = await ports.readDelivery(contactId);
  if (!read.ok)
    return { kind: "unreadable", reason: `delivery: ${read.reason}` };
  const status = read.delivery.status;
  if (status === "delivered") return { kind: "delivered" };
  if (status === "pending") return { kind: "pending" };
  if (status === "not-routed") return { kind: "notRouted" };
  // not-started: no value-path receipt. Only an absent actor snapshot
  // (404 contact-not-found) proves the birth itself is missing.
  const actor = await ports.readActor(contactId, OWNER_BIRTH_GUARD_JOURNEY_ID);
  if (!actor.ok)
    return { kind: "unreadable", reason: `actor: ${actor.reason}` };
  if (actor.found)
    return { kind: "actorWithoutSend", stateName: actor.stateName };
  const directory = await ports.readActor(contactId, DIRECTORY_JOURNEY_ID);
  if (!directory.ok)
    return { kind: "unreadable", reason: `directory: ${directory.reason}` };
  if (directory.found && STOPPED_DIRECTORY_STATE.test(directory.stateName))
    return { kind: "suppressed", stateName: directory.stateName };
  return { kind: "lost" };
}

async function checkPage(
  ports: OwnerBirthGuardPorts,
  window: { from: string; to: string },
  after: OwnerCursor | undefined,
  pageSize: number,
): Promise<PageResult> {
  const rows = await ports.scanOwners({ ...window, after, limit: pageSize });
  const counts = zeroCounts();
  counts.owners = rows.length;
  const real = rows.filter((row) => !isSyntheticPrincipalId(row.contactId));
  counts.skippedSynthetic = rows.length - real.length;
  // Required reads, never fail-open: a failure fails the step.
  const stopped = await ports.stoppedContactIds([
    ...new Set(real.map((row) => row.contactId)),
  ]);
  const reposted = await ports.repostedOwnerEventIds(real);
  const live = real.filter((row) => !stopped.has(row.contactId));
  counts.skippedStopped = real.length - live.length;

  const verdicts = await mapInBatches(live, READS_IN_FLIGHT, async (row) => ({
    row,
    verdict: await judge(ports, row.contactId),
  }));
  const candidates: Candidate[] = [];
  for (const { row, verdict } of verdicts) {
    const fields = {
      contactId: row.contactId,
      ownerEventId: row.id,
      occurredAt: row.occurredAt,
    };
    switch (verdict.kind) {
      case "delivered":
      case "pending":
      case "notRouted":
        counts[verdict.kind] += 1;
        break;
      case "unreadable":
        counts.unreadable += 1;
        await logSafely(ports.log.warn, "drovr.owner_birth_guard.unreadable", {
          ...fields,
          reason: verdict.reason,
        });
        break;
      case "actorWithoutSend":
        counts.actorWithoutSend += 1;
        await logSafely(
          ports.log.warn,
          "drovr.owner_birth_guard.actor_without_send",
          { ...fields, stateName: verdict.stateName },
        );
        break;
      case "suppressed":
        counts.skippedSuppressed += 1;
        await logSafely(ports.log.info, "drovr.owner_birth_guard.suppressed", {
          ...fields,
          stateName: verdict.stateName,
        });
        break;
      case "lost": {
        if (reposted.has(row.id)) {
          counts.repostNoEffect += 1;
          await logSafely(
            ports.log.warn,
            "drovr.owner_birth_guard.repost_no_effect",
            fields,
          );
          break;
        }
        const birth = mapDrovrShadowFact({
          kind: "contact-event",
          event: row,
        }).find(
          (event) =>
            event.type === "contact.created" &&
            event.journeyId === OWNER_BIRTH_GUARD_JOURNEY_ID,
        );
        if (!birth) {
          counts.unmappable += 1;
          break;
        }
        await logSafely(ports.log.warn, "drovr.owner_without_birth", {
          ...fields,
          idempotencyKey: birth.idempotencyKey,
        });
        candidates.push({ owner: row, birth });
        break;
      }
    }
  }
  const last = rows.at(-1);
  return {
    ...counts,
    candidates,
    ...(rows.length === pageSize && last
      ? { next: { occurredAt: last.occurredAt, id: last.id } }
      : {}),
  };
}

function repostOutcomeOf(outcome: DrovrDeliveryOutcome): RepostOutcome {
  if (outcome.status === "accepted") return "accepted";
  const problem = outcome.status === "rejected" ? outcome.problem : undefined;
  const text =
    typeof problem === "string" ? problem : JSON.stringify(problem ?? "");
  return /suppress/i.test(text) ? "suppressed" : "rejected";
}

type GuardStep = {
  run<T>(id: string, operation: () => Promise<T>): Promise<unknown>;
};

/**
 * One guard run as Inngest steps: each page (reads and their logs) is one
 * memoized step, each re-post one step keyed by its owner event, then the
 * summary. A replay neither re-reads nor re-posts nor re-logs.
 */
export async function runOwnerBirthGuard(args: {
  step: GuardStep;
  ports: OwnerBirthGuardPorts;
  /** From a memoized step, so every replay reads the same window. */
  startedAtMs: number;
  pageSize?: number;
  cap?: number;
}): Promise<OwnerBirthGuardReceipt> {
  const { step, ports } = args;
  const pageSize = args.pageSize ?? 50;
  const cap = args.cap ?? OWNER_BIRTH_GUARD_REPOST_CAP;
  const window = {
    from: new Date(
      args.startedAtMs - OWNER_BIRTH_GUARD_MAX_AGE_MS,
    ).toISOString(),
    to: new Date(args.startedAtMs - OWNER_BIRTH_GUARD_MIN_AGE_MS).toISOString(),
  };
  const counts = zeroCounts();
  const candidates: Candidate[] = [];
  let after: OwnerCursor | undefined;
  let pages = 0;
  let truncated = false;
  for (;;) {
    if (pages === MAX_PAGES) {
      truncated = true;
      break;
    }
    const from = after;
    const page = (await step.run(`page-${pages}`, () =>
      checkPage(ports, window, from, pageSize),
    )) as PageResult;
    pages += 1;
    for (const key of Object.keys(counts) as (keyof PageCounts)[])
      counts[key] += page[key];
    candidates.push(...page.candidates);
    if (!page.next) break;
    after = page.next;
  }

  const outcomes: RepostOutcome[] = [];
  for (const { owner, birth } of candidates.slice(0, cap)) {
    outcomes.push(
      (await step.run(`repost-${owner.id}`, async () => {
        const outcome = repostOutcomeOf(await ports.post(birth));
        await ports.recordRepost(owner, outcome);
        return outcome;
      })) as RepostOutcome,
    );
  }
  const overCap = Math.max(0, candidates.length - cap);
  const receipt: OwnerBirthGuardReceipt = {
    status: "checked",
    ...window,
    pages,
    ...counts,
    candidates: candidates.length,
    reposted: outcomes.filter((outcome) => outcome === "accepted").length,
    suppressedOnPost: outcomes.filter((outcome) => outcome === "suppressed")
      .length,
    rejectedOnPost: outcomes.filter((outcome) => outcome === "rejected").length,
    capHit: overCap > 0,
    overCap,
    truncated,
  };
  await step.run("summary", async () => {
    if (receipt.capHit)
      await logSafely(ports.log.warn, "drovr.owner_birth_guard.cap_hit", {
        cap,
        candidates: receipt.candidates,
        overCap,
      });
    await logSafely(ports.log.info, "drovr.owner_birth_guard.summary", receipt);
    return true;
  });
  return receipt;
}
