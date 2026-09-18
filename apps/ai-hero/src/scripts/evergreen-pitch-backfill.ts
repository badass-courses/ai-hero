import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import {
  CRASH_COURSE_PRODUCT_ID,
  CRASH_COURSE_PURCHASE_STATUSES,
  hasCrashCoursePurchaseForIdentity,
  type EvergreenPitchEntryResult,
} from "@/lib/subscriber-marketing/drovr-pitch-entry";
import { enterEvergreenPitchFromLiveDatabase } from "@/lib/subscriber-marketing/drovr-ownership-live";
import {
  JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
  journeyOwnerProviderEventId,
} from "@/lib/subscriber-marketing/drovr-ownership";
import {
  dispatchDrovrShadowFact,
  sendDrovrEventsDeliverViaInngestHttp,
} from "@/lib/subscriber-marketing/drovr-shadow-dispatch";
import {
  DROVR_EVERGREEN_OFFER_JOURNEY_ID,
  type DrovrShadowFact,
} from "@/lib/subscriber-marketing/drovr-shadow-emitter";
import { getSkillsWorkflowEmailStep } from "@/lib/subscriber-marketing/skills-workflow-path";

export const DEFAULT_BACKFILL_FLOOR = "2026-08-26T00:00:00.000Z";
export const EVERGREEN_PITCH_ENABLE_INSTANT = "2026-09-18T01:47:44.000Z";

const TERMINAL_EMAIL_RESOURCE_IDS = [
  "ai-hero-skills-workflow.email-7",
  "ai-hero-skills-team-workflow.team-email-7",
] as const;

export type BackfillPopulationRow = {
  intentId: string;
  contactId: string;
  completedAt: string;
  emailResourceId: string;
  valuePathSlug: string;
};

export type BackfillCandidate = {
  contactId: string;
  completedAt: string;
  valuePathSlug: string;
};

export type BackfillRefusalReason =
  | "crash-course-purchaser"
  | "unsubscribed"
  | "contact-or-identity-missing"
  | "already-entered";

export type EvergreenPitchBackfillSummary = {
  runId: string;
  mode: "dry-run" | "apply";
  floor: string;
  enableInstant: string;
  birthInstant: string;
  runDate: string;
  requested: number;
  selected: number;
  entered: number;
  enteredContactIds: string[];
  refused: Record<BackfillRefusalReason, number>;
  errors: string[];
};

export type EvergreenPitchBackfillRepository = {
  loadPopulation(args: {
    floor: string;
    enableInstant: string;
    limit: number;
  }): Promise<BackfillCandidate[]>;
  findCrashCoursePurchaserContactIds(
    contactIds: readonly string[],
  ): Promise<string[]>;
  enterEvergreenPitch(args: {
    contactId: string;
    completedAt: string;
  }): Promise<EvergreenPitchEntryResult>;
  dispatchFact(
    fact: Extract<DrovrShadowFact, { kind: "course-completed" }>,
  ): Promise<"queued" | "fallback" | "nothing">;
};

export type EvergreenPitchBackfillArgs = {
  floor: string;
  enableInstant: string;
  limit: number;
  apply: boolean;
  out: string;
};

export function resolveBackfillApplyInngestEventKey(
  source: Record<string, string | undefined>,
  options: { apply: boolean },
): string | null {
  if (!options.apply) return null;
  const eventKey = source.INNGEST_EVENT_KEY?.trim();
  if (!eventKey) throw new Error("Apply requires INNGEST_EVENT_KEY");
  if (eventKey === "[SENSITIVE]") {
    throw new Error(
      'INNGEST_EVENT_KEY holds the Vercel "[SENSITIVE]" placeholder, not a usable value',
    );
  }
  return eventKey;
}

export function createBackfillFactDispatcher(args: {
  eventKey: string;
  fetchImpl?: typeof fetch;
}): EvergreenPitchBackfillRepository["dispatchFact"] {
  return (fact) =>
    dispatchDrovrShadowFact(fact, {
      evergreenEnabled: false,
      send: (payload) =>
        sendDrovrEventsDeliverViaInngestHttp(payload, {
          eventKey: args.eventKey,
          fetchImpl: args.fetchImpl,
        }),
      // A rejected HTTP handoff is terminal for this run. Do not bypass the
      // durable path with the direct drovr fallback used by the live host.
      resolveOwners: async () => [],
      fallback: async () => undefined,
    });
}

export function parseEvergreenPitchBackfillArgs(
  argv: readonly string[],
): EvergreenPitchBackfillArgs {
  let floor = DEFAULT_BACKFILL_FLOOR;
  let limit: number | undefined;
  let out: string | undefined;
  let apply = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (
      argument === "--floor" ||
      argument === "--limit" ||
      argument === "--out"
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--floor") floor = value;
      if (argument === "--limit")
        limit = parsePositiveInteger(value, "--limit");
      if (argument === "--out") out = value;
      continue;
    }
    if (argument.startsWith("--floor=")) {
      floor = argument.slice("--floor=".length);
      continue;
    }
    if (argument.startsWith("--limit=")) {
      limit = parsePositiveInteger(
        argument.slice("--limit=".length),
        "--limit",
      );
      continue;
    }
    if (argument.startsWith("--out=")) {
      out = argument.slice("--out=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (apply && dryRun) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  if (limit === undefined) throw new Error("--limit is required");
  if (!out) throw new Error("--out is required");
  const normalizedFloor = parseInstant(floor, "--floor");
  if (
    Date.parse(normalizedFloor) >= Date.parse(EVERGREEN_PITCH_ENABLE_INSTANT)
  ) {
    throw new Error("--floor must be before the enable instant");
  }
  return {
    floor: normalizedFloor,
    enableInstant: EVERGREEN_PITCH_ENABLE_INSTANT,
    limit,
    apply,
    out,
  };
}

/** Pure population policy over read-only rows. Entry eligibility remains the seam's job. */
export function selectBackfillPopulation(args: {
  rows: readonly BackfillPopulationRow[];
  floor: string;
  enableInstant: string;
  limit: number;
  alreadyEnteredContactIds: ReadonlySet<string>;
  purchaserContactIds: ReadonlySet<string>;
}): BackfillCandidate[] {
  const floorMs = Date.parse(args.floor);
  const enableMs = Date.parse(args.enableInstant);
  const seenContactIds = new Set<string>();
  const selected: BackfillCandidate[] = [];
  const ordered = [...args.rows].sort((left, right) => {
    const timeOrder =
      Date.parse(right.completedAt) - Date.parse(left.completedAt);
    return timeOrder === 0
      ? right.intentId.localeCompare(left.intentId)
      : timeOrder;
  });

  for (const row of ordered) {
    const completedAtMs = Date.parse(row.completedAt);
    const step = getSkillsWorkflowEmailStep(row.emailResourceId);
    if (
      !Number.isFinite(completedAtMs) ||
      completedAtMs < floorMs ||
      completedAtMs >= enableMs ||
      !step ||
      !TERMINAL_EMAIL_RESOURCE_IDS.some(
        (resourceId) => resourceId === row.emailResourceId,
      ) ||
      step.valuePathSlug !== row.valuePathSlug ||
      seenContactIds.has(row.contactId)
    ) {
      continue;
    }
    seenContactIds.add(row.contactId);
    if (
      args.alreadyEnteredContactIds.has(row.contactId) ||
      args.purchaserContactIds.has(row.contactId)
    ) {
      continue;
    }
    selected.push({
      contactId: row.contactId,
      completedAt: row.completedAt,
      valuePathSlug: row.valuePathSlug,
    });
    if (selected.length === args.limit) break;
  }
  return selected;
}

export async function runEvergreenPitchBackfill(args: {
  repository: EvergreenPitchBackfillRepository;
  floor: string;
  enableInstant: string;
  limit: number;
  apply: boolean;
  birthInstant: string;
  logRefusal?: (args: {
    contactId: string;
    reason: BackfillRefusalReason;
  }) => void;
}): Promise<EvergreenPitchBackfillSummary> {
  const runDate = args.birthInstant.slice(0, 10);
  const summary: EvergreenPitchBackfillSummary = {
    runId: `evergreen-pitch-backfill-${compactTimestamp(args.birthInstant)}`,
    mode: args.apply ? "apply" : "dry-run",
    floor: args.floor,
    enableInstant: args.enableInstant,
    birthInstant: args.birthInstant,
    runDate,
    requested: args.limit,
    selected: 0,
    entered: 0,
    enteredContactIds: [],
    refused: emptyRefusalCounts(),
    errors: [],
  };
  const population = await args.repository.loadPopulation({
    floor: args.floor,
    enableInstant: args.enableInstant,
    limit: args.limit,
  });
  summary.selected = population.length;

  const purchaserContactIds =
    await args.repository.findCrashCoursePurchaserContactIds(
      population.map((candidate) => candidate.contactId),
    );
  if (purchaserContactIds.length > 0) {
    for (const contactId of purchaserContactIds) {
      recordRefusal(
        summary,
        contactId,
        "crash-course-purchaser",
        args.logRefusal,
      );
    }
    summary.errors.push(
      `population-abort: ${purchaserContactIds.length} live Crash Course purchaser${purchaserContactIds.length === 1 ? "" : "s"} in selected slice`,
    );
    return summary;
  }
  if (!args.apply) return summary;

  for (const candidate of population) {
    try {
      const entry = await args.repository.enterEvergreenPitch({
        contactId: candidate.contactId,
        // The actor is born into this run, never at historic completion.
        completedAt: args.birthInstant,
      });
      if (entry.status === "already-entered") {
        recordRefusal(
          summary,
          candidate.contactId,
          "already-entered",
          args.logRefusal,
        );
        continue;
      }
      if (entry.status === "refused") {
        if (entry.reason === "course-not-finished") {
          throw new Error(
            "entry seam contradicted the terminal finisher population",
          );
        }
        recordRefusal(
          summary,
          candidate.contactId,
          entry.reason,
          args.logRefusal,
        );
        continue;
      }

      summary.enteredContactIds.push(candidate.contactId);
      const idempotencyKey = [
        "aihero",
        "backfill",
        candidate.contactId,
        candidate.valuePathSlug,
        runDate,
      ].join(":");
      const delivery = await args.repository.dispatchFact({
        kind: "course-completed",
        contactId: candidate.contactId,
        valuePathSlug: candidate.valuePathSlug,
        completedAt: candidate.completedAt,
        backfill: {
          occurredAt: args.birthInstant,
          idempotencyKey,
        },
      });
      if (delivery !== "queued") {
        throw new Error(`backfill dispatch returned ${delivery}`);
      }
      summary.entered += 1;
    } catch (error) {
      summary.errors.push(
        `contact ${candidate.contactId}: ${errorMessage(error)}`,
      );
      break;
    }
  }
  return summary;
}

export async function createLiveEvergreenPitchBackfillRepository(args: {
  inngestEventKey: string | null;
}): Promise<EvergreenPitchBackfillRepository> {
  const dispatchFact = args.inngestEventKey
    ? createBackfillFactDispatcher({ eventKey: args.inngestEventKey })
    : async () => {
        throw new Error("Apply requires INNGEST_EVENT_KEY");
      };
  const [{ db }, schema] = await Promise.all([
    import("@/db"),
    import("@/db/schema"),
  ]);
  const terminalEmailResourceId = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${schema.sideEffectIntent.metadata}, '$.emailResourceId'))`;

  async function findCrashCoursePurchaserContactIds(
    contactIds: readonly string[],
  ): Promise<string[]> {
    if (contactIds.length === 0) return [];
    const contacts = [];
    const links = [];
    for (const contactIdBatch of chunk(contactIds, 500)) {
      contacts.push(
        ...(await db
          .select({
            id: schema.contact.id,
            userId: schema.contact.userId,
            email: schema.contact.email,
          })
          .from(schema.contact)
          .where(inArray(schema.contact.id, contactIdBatch))),
      );
      links.push(
        ...(await db
          .select({
            contactId: schema.contactLink.contactId,
            userId: schema.contactLink.userId,
          })
          .from(schema.contactLink)
          .where(inArray(schema.contactLink.contactId, contactIdBatch))),
      );
    }
    const purchases = await db
      .select({
        userId: schema.purchases.userId,
        userEmail: schema.users.email,
        productId: schema.purchases.productId,
        status: schema.purchases.status,
      })
      .from(schema.purchases)
      .leftJoin(schema.users, eq(schema.purchases.userId, schema.users.id))
      .where(
        and(
          eq(schema.purchases.productId, CRASH_COURSE_PRODUCT_ID),
          inArray(schema.purchases.status, [...CRASH_COURSE_PURCHASE_STATUSES]),
        ),
      );
    const linksByContactId = new Map<string, string[]>();
    for (const link of links) {
      const values = linksByContactId.get(link.contactId) ?? [];
      values.push(link.userId);
      linksByContactId.set(link.contactId, values);
    }
    return contacts.flatMap((contact) =>
      hasCrashCoursePurchaseForIdentity({
        userIds: [
          ...(contact.userId ? [contact.userId] : []),
          ...(linksByContactId.get(contact.id) ?? []),
        ],
        emails: contact.email ? [contact.email] : [],
        purchases,
      })
        ? [contact.id]
        : [],
    );
  }

  return {
    async loadPopulation(args) {
      const rows = await db
        .select({
          intentId: schema.sideEffectIntent.id,
          contactId: schema.sideEffectIntent.contactId,
          completedAt: schema.sideEffectIntent.completedAt,
          emailResourceId: terminalEmailResourceId,
          metadata: schema.sideEffectIntent.metadata,
        })
        .from(schema.sideEffectIntent)
        .where(
          and(
            eq(schema.sideEffectIntent.provider, "kit"),
            eq(schema.sideEffectIntent.type, "send-value-path-email"),
            eq(schema.sideEffectIntent.status, "completed"),
            gte(schema.sideEffectIntent.completedAt, new Date(args.floor)),
            lt(
              schema.sideEffectIntent.completedAt,
              new Date(args.enableInstant),
            ),
            inArray(terminalEmailResourceId, [...TERMINAL_EMAIL_RESOURCE_IDS]),
          ),
        )
        .orderBy(
          desc(schema.sideEffectIntent.completedAt),
          desc(schema.sideEffectIntent.id),
        );
      const populationRows = rows.flatMap((row): BackfillPopulationRow[] => {
        if (!row.completedAt) return [];
        const step = getSkillsWorkflowEmailStep(row.emailResourceId);
        const metadataSlug = stringValue(row.metadata.valuePathSlug);
        const valuePathSlug = metadataSlug ?? step?.valuePathSlug;
        if (!valuePathSlug) return [];
        return [
          {
            intentId: row.intentId,
            contactId: row.contactId,
            completedAt: new Date(row.completedAt).toISOString(),
            emailResourceId: row.emailResourceId,
            valuePathSlug,
          },
        ];
      });
      const contactIds = Array.from(
        new Set(populationRows.map((row) => row.contactId)),
      );
      const alreadyEnteredContactIds = new Set<string>();
      for (const contactIdBatch of chunk(contactIds, 500)) {
        const providerEventIds = contactIdBatch.map((contactId) =>
          journeyOwnerProviderEventId(
            contactId,
            DROVR_EVERGREEN_OFFER_JOURNEY_ID,
          ),
        );
        const owners = await db
          .select({ contactId: schema.contactEvent.contactId })
          .from(schema.contactEvent)
          .where(
            and(
              eq(
                schema.contactEvent.eventType,
                JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
              ),
              inArray(schema.contactEvent.providerEventId, providerEventIds),
            ),
          );
        for (const owner of owners)
          alreadyEnteredContactIds.add(owner.contactId);
      }
      const purchaserContactIds = new Set(
        await findCrashCoursePurchaserContactIds(contactIds),
      );
      return selectBackfillPopulation({
        rows: populationRows,
        floor: args.floor,
        enableInstant: args.enableInstant,
        limit: args.limit,
        alreadyEnteredContactIds,
        purchaserContactIds,
      });
    },
    findCrashCoursePurchaserContactIds,
    enterEvergreenPitch: enterEvergreenPitchFromLiveDatabase,
    // Entry already ran above. Backfill mapping addresses only the authority
    // evergreen actor, so the forward-route entry hook must not run again.
    dispatchFact,
  };
}

function emptyRefusalCounts(): Record<BackfillRefusalReason, number> {
  return {
    "crash-course-purchaser": 0,
    unsubscribed: 0,
    "contact-or-identity-missing": 0,
    "already-entered": 0,
  };
}

function recordRefusal(
  summary: EvergreenPitchBackfillSummary,
  contactId: string,
  reason: BackfillRefusalReason,
  logRefusal:
    | ((args: { contactId: string; reason: BackfillRefusalReason }) => void)
    | undefined,
) {
  summary.refused[reason] += 1;
  logRefusal?.({ contactId, reason });
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseInstant(value: string, flag: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${flag} requires a valid ISO instant`);
  }
  return parsed.toISOString();
}

function compactTimestamp(value: string): string {
  return value.replaceAll("-", "").replaceAll(":", "").replace(".000", "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function chunk<Value>(values: readonly Value[], size: number): Value[][] {
  const chunks: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function main() {
  const args = parseEvergreenPitchBackfillArgs(process.argv.slice(2));
  const inngestEventKey = resolveBackfillApplyInngestEventKey(process.env, {
    apply: args.apply,
  });
  const birthInstant = new Date().toISOString();
  let summary: EvergreenPitchBackfillSummary;
  try {
    const repository = await createLiveEvergreenPitchBackfillRepository({
      inngestEventKey,
    });
    summary = await runEvergreenPitchBackfill({
      repository,
      floor: args.floor,
      enableInstant: args.enableInstant,
      limit: args.limit,
      apply: args.apply,
      birthInstant,
      logRefusal: (refusal) => {
        console.error(JSON.stringify({ type: "refusal", ...refusal }));
      },
    });
  } catch (error) {
    summary = {
      runId: `evergreen-pitch-backfill-${compactTimestamp(birthInstant)}`,
      mode: args.apply ? "apply" : "dry-run",
      floor: args.floor,
      enableInstant: args.enableInstant,
      birthInstant,
      runDate: birthInstant.slice(0, 10),
      requested: args.limit,
      selected: 0,
      entered: 0,
      enteredContactIds: [],
      refused: emptyRefusalCounts(),
      errors: [`run: ${errorMessage(error)}`],
    };
  }
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors.length > 0) process.exitCode = 1;
  const { closeDatabasePool } = await import("@/db");
  await closeDatabasePool();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
