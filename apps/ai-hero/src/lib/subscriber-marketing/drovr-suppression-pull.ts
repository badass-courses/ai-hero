import type { ContactUnsubscribed } from "@/inngest/events/contact-unsubscribed";
import { CONTACT_UNSUBSCRIBED_EVENT } from "@/inngest/events/contact-unsubscribed";

/**
 * drovr -> ai-hero stops (option 2 of the K25 retirement, 2026-11-08).
 *
 * Every stop source converges on drovr's suppressions: its Kit webhook (K1),
 * its own unsubscribe links, imports. ai-hero pages drovr's
 * `GET /suppressions` from a stored cursor and turns each active,
 * account-wide suppression of a contact it knows into the same
 * contact-unsubscribed events its Kit webhook (K25) sends. So
 * capture-contact-unsubscribed writes the stop into the ContactEvent log,
 * dedupes it against K25's row on the same (email, preference) key, and
 * every isContactStopped reader (enrolment, births, the preferences page)
 * sees it without a network call of its own.
 *
 * Course-scoped suppressions (`course:...`) stop one drovr course, not the
 * contact, and are left to drovr. A lifted suppression is skipped: the lift
 * is a fresh double opt-in, which ai-hero records itself as
 * contact.resubscribed. The cursor moves only after a page's events are
 * queued, so a failure re-reads the page; the event ids and the
 * ContactEvent key make that harmless.
 */

/** drovr's account-wide scope (drovr packages/storage/src/kit-stop-tags.ts). */
export const DROVR_SCOPE_ALL = "all";

/** Where a first run starts: covers the K25 parity window, not all history. */
export const DROVR_SUPPRESSION_PULL_START = "2026-11-01T00:00:00.000Z";

/** Same preferences as K25: a provider stop is account-wide. */
export const SUPPRESSION_PREFERENCE_KEYS = ["newsletter", "ai-skills"] as const;

export const SUPPRESSION_PULL_PAGE_LIMIT = 200;
export const SUPPRESSION_PULL_MAX_PAGES = 10;

/** drovr mints `contact-<uuid>` for a Kit subscriber it could not bind. */
export const DROVR_MINTED_CONTACT_PREFIX = "contact-";
export const MINTED_SAMPLE_MAX = 5;

export type DrovrSuppressionReason = "unsubscribed" | "bounced" | "complained";

export type DrovrSuppression = {
  contactId: string;
  reason: DrovrSuppressionReason;
  scope: string;
  lifted: boolean;
  createdAt: string;
  /** drovr's fact time, once its contract carries it; createdAt otherwise. */
  factAt?: string;
  /** Where drovr heard the stop (kit, unsubscribe-link, ...), once carried. */
  source?: string;
};

export type DrovrSuppressionPage = {
  suppressions: DrovrSuppression[];
  /** null when caught up. */
  nextCursor: string | null;
  /** Where the next run resumes once caught up. */
  resumeCursor: string;
};

export type DrovrSuppressionRead =
  | { ok: true; page: DrovrSuppressionPage }
  | { ok: false; reason: string; status?: number };

export type SuppressionPullCursor = { cursor: string } | { since: string };

export type SuppressionPullPorts = {
  readCursor(): Promise<string | undefined>;
  writeCursor(cursor: string): Promise<void>;
  readPage(at: SuppressionPullCursor): Promise<DrovrSuppressionRead>;
  /** id -> email for the ids ai-hero holds; unknown ids are absent. */
  contactEmails(contactIds: readonly string[]): Promise<Map<string, string>>;
  send(events: SuppressionStopEvent[]): Promise<void>;
};

export type SuppressionStopEvent = ContactUnsubscribed & { id: string };

export type SuppressionPullCounts = {
  pages: number;
  rows: number;
  queued: number;
  skippedLifted: number;
  skippedCourseScope: number;
  skippedUnknownContact: number;
  skippedNoEmail: number;
};

export type SuppressionPullReceipt = {
  status: "caught-up" | "more" | "failed";
  counts: SuppressionPullCounts;
  reason?: string;
};

const REASONS: ReadonlySet<string> = new Set([
  "unsubscribed",
  "bounced",
  "complained",
]);

const stringOr = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** One row, or undefined when it is not a suppression we can read. */
export function suppressionOf(value: unknown): DrovrSuppression | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const contactId = stringOr(row.contactId);
  const scope = stringOr(row.scope);
  const createdAt = stringOr(row.createdAt);
  const reason = stringOr(row.reason);
  if (!contactId || !scope || !createdAt || !reason || !REASONS.has(reason))
    return undefined;
  if (typeof row.lifted !== "boolean") return undefined;
  if (!Number.isFinite(Date.parse(createdAt))) return undefined;
  const factAt = stringOr(row.factAt);
  return {
    contactId,
    reason: reason as DrovrSuppressionReason,
    scope,
    lifted: row.lifted,
    createdAt,
    ...(factAt && Number.isFinite(Date.parse(factAt)) ? { factAt } : {}),
    ...(stringOr(row.source) ? { source: stringOr(row.source) } : {}),
  };
}

/**
 * A page, or undefined if any row is unreadable: a page is all or nothing,
 * so a malformed row can never be skipped past by moving the cursor.
 */
export function suppressionPageOf(
  body: unknown,
): DrovrSuppressionPage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.suppressions)) return undefined;
  const resumeCursor = stringOr(record.resumeCursor);
  if (!resumeCursor) return undefined;
  const nextCursor =
    record.nextCursor === null ? null : stringOr(record.nextCursor);
  if (nextCursor === undefined) return undefined;
  const suppressions: DrovrSuppression[] = [];
  for (const row of record.suppressions) {
    const suppression = suppressionOf(row);
    if (!suppression) return undefined;
    suppressions.push(suppression);
  }
  return { suppressions, nextCursor, resumeCursor };
}

/** The ContactUnsubscribed events for one page, plus what was skipped. */
export function planSuppressionStops(
  suppressions: readonly DrovrSuppression[],
  emails: ReadonlyMap<string, string>,
): {
  events: SuppressionStopEvent[];
  counts: Omit<SuppressionPullCounts, "pages" | "rows">;
} {
  const counts = {
    queued: 0,
    skippedLifted: 0,
    skippedCourseScope: 0,
    skippedUnknownContact: 0,
    skippedNoEmail: 0,
  };
  const events: SuppressionStopEvent[] = [];
  for (const row of suppressions) {
    if (row.scope !== DROVR_SCOPE_ALL) {
      counts.skippedCourseScope++;
      continue;
    }
    if (row.lifted) {
      counts.skippedLifted++;
      continue;
    }
    if (!emails.has(row.contactId)) {
      counts.skippedUnknownContact++;
      continue;
    }
    const email = emails.get(row.contactId)?.trim();
    if (!email) {
      counts.skippedNoEmail++;
      continue;
    }
    const occurredAt = row.factAt ?? row.createdAt;
    for (const preferenceKey of SUPPRESSION_PREFERENCE_KEYS) {
      events.push({
        id: suppressionEventId(row, preferenceKey),
        name: CONTACT_UNSUBSCRIBED_EVENT,
        data: {
          email,
          preferenceKey,
          source: `drovr-suppression:${row.reason}`,
          occurredAt,
        },
      });
    }
    counts.queued++;
  }
  return { events, counts };
}

/** Inngest dedupes on id: a re-read page queues nothing twice in 24h. */
export function suppressionEventId(
  row: Pick<DrovrSuppression, "contactId" | "scope" | "reason" | "createdAt">,
  preferenceKey: string,
): string {
  return `drovr-suppression:${row.contactId}:${row.scope}:${row.reason}:${row.createdAt}:${preferenceKey}`;
}

export async function runSuppressionPull(
  ports: SuppressionPullPorts,
  options: { maxPages?: number; start?: string } = {},
): Promise<SuppressionPullReceipt> {
  const counts: SuppressionPullCounts = {
    pages: 0,
    rows: 0,
    queued: 0,
    skippedLifted: 0,
    skippedCourseScope: 0,
    skippedUnknownContact: 0,
    skippedNoEmail: 0,
  };
  const stored = await ports.readCursor();
  let at: SuppressionPullCursor = stored
    ? { cursor: stored }
    : { since: options.start ?? DROVR_SUPPRESSION_PULL_START };
  const maxPages = options.maxPages ?? SUPPRESSION_PULL_MAX_PAGES;
  for (let page = 0; page < maxPages; page++) {
    const read = await ports.readPage(at);
    if (!read.ok) return { status: "failed", counts, reason: read.reason };
    counts.pages++;
    counts.rows += read.page.suppressions.length;
    const ids = [
      ...new Set(read.page.suppressions.map((row) => row.contactId)),
    ];
    const emails = ids.length > 0 ? await ports.contactEmails(ids) : new Map();
    const plan = planSuppressionStops(read.page.suppressions, emails);
    if (plan.events.length > 0) await ports.send(plan.events);
    counts.queued += plan.counts.queued;
    counts.skippedLifted += plan.counts.skippedLifted;
    counts.skippedCourseScope += plan.counts.skippedCourseScope;
    counts.skippedUnknownContact += plan.counts.skippedUnknownContact;
    counts.skippedNoEmail += plan.counts.skippedNoEmail;
    const next = read.page.nextCursor ?? read.page.resumeCursor;
    await ports.writeCursor(next);
    if (read.page.nextCursor === null) return { status: "caught-up", counts };
    at = { cursor: read.page.nextCursor };
  }
  return { status: "more", counts };
}
