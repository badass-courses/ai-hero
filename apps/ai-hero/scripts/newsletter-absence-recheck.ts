import { z } from "zod";
import {
  KIT_PAGE_ATTEMPTS,
  KIT_REQUEST_TIMEOUT_MS,
} from "./held-exit-kit-scan";
import { OLD_SEQUENCE_ID, RecoveryRefused } from "./held-exit-recover";
import type { AbsenceRecheckRuntime } from "./newsletter-absence-proof";

/** Kit API keys get 120 requests a rolling minute; stay at or under it. */
export const KIT_RECHECK_MIN_INTERVAL_MS = 500;
/** How old the since-snapshot add list may be when a reader is checked against it. */
export const SEQUENCE_DELTA_MAX_AGE_MS = 60_000;
export const MAX_DELTA_PAGES = 50;
const MAX_RETRY_DELAY_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

const unavailable = () =>
  new RecoveryRefused({ reason: "recheck-unavailable" });

const subscriberSchema = z.object({
  subscriber: z.object({
    id: z.number().int().positive(),
    state: z.string().min(1),
  }),
});
const deltaPageSchema = z.object({
  subscribers: z.array(z.object({ id: z.number().int().positive() })).max(1000),
  pagination: z.object({
    has_next_page: z.boolean(),
    end_cursor: z.string().nullable().optional(),
  }),
});

/** Kit's `added_after` takes a date. A day early widens the list, never narrows it:
 * anyone it adds who was in the full scan is already `old-sequence-member`. */
export const addedAfterDate = (since: string) => {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) throw unavailable();
  return new Date(at - DAY_MS).toISOString().slice(0, 10);
};

/** Kit's answers to the write's per-reader rechecks. Kit has no per-subscriber
 * sequence read, so "now in 2625552" is one short list of adds since the
 * snapshot, refreshed each minute, matched per subscriber in memory. Only GETs. */
export function createKitAbsenceRecheck(options: {
  apiKey: string;
  fetch: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Pick<
  AbsenceRecheckRuntime,
  "kitSubscriberState" | "oldSequenceAddedSince"
> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw unavailable();
  const nowMs = options.nowMs ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let nextSlot = 0;
  // One shared request clock, so concurrent readers never burst past the limit.
  const throttle = async () => {
    const now = nowMs();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + KIT_RECHECK_MIN_INTERVAL_MS;
    if (slot > now) await sleep(slot - now);
  };
  const get = async (url: URL): Promise<unknown> => {
    for (let attempt = 1; attempt <= KIT_PAGE_ATTEMPTS; attempt++) {
      await throttle();
      let response: Response;
      try {
        response = await options.fetch(url.toString(), {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(KIT_REQUEST_TIMEOUT_MS),
          headers: { "X-Kit-Api-Key": apiKey },
        });
      } catch {
        if (attempt === KIT_PAGE_ATTEMPTS) throw unavailable();
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (response.redirected) throw unavailable();
      if (response.status === 200)
        return response.json().catch(() => {
          throw unavailable();
        });
      const transient =
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599);
      await response.body?.cancel();
      if (!transient || attempt === KIT_PAGE_ATTEMPTS) throw unavailable();
      const header = response.headers.get("retry-after");
      // Retry-After is delay-seconds or an HTTP date.
      const retryAfter =
        header === null
          ? Number.NaN
          : Number.isFinite(Number(header))
            ? Number(header) * 1000
            : Date.parse(header) - nowMs();
      const delay = Number.isFinite(retryAfter)
        ? Math.max(retryAfter, 0)
        : 1000 * 2 ** (attempt - 1);
      if (delay > MAX_RETRY_DELAY_MS) throw unavailable();
      await sleep(delay);
    }
    throw unavailable();
  };

  const readAdds = async (since: string) => {
    const added = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DELTA_PAGES; page++) {
      const url = new URL(
        `https://api.kit.com/v4/sequences/${OLD_SEQUENCE_ID}/subscribers`,
      );
      url.searchParams.set("status", "all");
      url.searchParams.set("per_page", "1000");
      url.searchParams.set("added_after", addedAfterDate(since));
      if (cursor) url.searchParams.set("after", cursor);
      const decoded = deltaPageSchema.safeParse(await get(url));
      if (!decoded.success) throw unavailable();
      for (const member of decoded.data.subscribers)
        added.add(String(member.id));
      const { has_next_page, end_cursor } = decoded.data.pagination;
      if (!has_next_page) return added;
      if (!end_cursor || cursors.has(end_cursor)) throw unavailable();
      cursors.add(end_cursor);
      cursor = end_cursor;
    }
    // A capped list is not a complete one.
    throw unavailable();
  };
  let delta:
    | { since: string; readAt: number; adds: Promise<Set<string>> }
    | undefined;

  return {
    kitSubscriberState: async (subscriberId) => {
      if (!/^[1-9]\d*$/.test(subscriberId)) throw unavailable();
      const decoded = subscriberSchema.safeParse(
        await get(
          new URL(`https://api.kit.com/v4/subscribers/${subscriberId}`),
        ),
      );
      if (
        !decoded.success ||
        String(decoded.data.subscriber.id) !== subscriberId
      )
        throw unavailable();
      return decoded.data.subscriber.state;
    },
    oldSequenceAddedSince: async (subscriberId, since) => {
      if (!/^[1-9]\d*$/.test(subscriberId)) throw unavailable();
      let current = delta;
      if (
        !current ||
        current.since !== since ||
        nowMs() - current.readAt > SEQUENCE_DELTA_MAX_AGE_MS
      ) {
        const fresh = { since, readAt: nowMs(), adds: readAdds(since) };
        delta = current = fresh;
        // A failed read is never reused: the next reader asks Kit again.
        fresh.adds.catch(() => {
          if (delta === fresh) delta = undefined;
        });
      }
      return (await current.adds).has(subscriberId);
    },
  };
}
