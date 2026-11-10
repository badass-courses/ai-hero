import { contactSyncCursor } from "@/db/contact-sync-schema";
import { contact } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

import {
  DROVR_SCOPE_ALL,
  SUPPRESSION_PULL_PAGE_LIMIT,
  suppressionPageOf,
  type DrovrSuppressionRead,
  type SuppressionPullCursor,
} from "./drovr-suppression-pull";

/** A ContactSyncCursor row of its own, so no schema change. */
export const SUPPRESSION_PULL_CURSOR_NAME = "drovr-suppressions";

/** ContactSyncCursor.cursor is varchar(500): refuse rather than truncate. */
export const SUPPRESSION_PULL_CURSOR_MAX = 500;

export function suppressionsUrl(
  baseUrl: string,
  at: SuppressionPullCursor,
  limit = SUPPRESSION_PULL_PAGE_LIMIT,
): string {
  const params = new URLSearchParams({
    scope: DROVR_SCOPE_ALL,
    limit: String(limit),
  });
  if ("cursor" in at) params.set("cursor", at.cursor);
  else params.set("since", at.since);
  return `${baseUrl.replace(/\/+$/, "")}/suppressions?${params.toString()}`;
}

/** drovr's `GET /suppressions`, one page. Anything unexpected is a failure. */
export async function readDrovrSuppressions(args: {
  at: SuppressionPullCursor;
  config: { baseUrl: string | undefined; apiKey: string | undefined };
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): Promise<DrovrSuppressionRead> {
  const { baseUrl, apiKey } = args.config;
  if (!baseUrl || !apiKey)
    return { ok: false, reason: "drovr is not configured" };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    args.timeoutMs ?? 15_000,
  );
  try {
    const response = await (args.fetcher ?? fetch)(
      suppressionsUrl(baseUrl, args.at),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      },
    );
    if (response.status !== 200)
      return {
        ok: false,
        status: response.status,
        reason: `drovr answered ${response.status}`,
      };
    const page = suppressionPageOf(await response.json());
    if (!page)
      return {
        ok: false,
        reason: "drovr answered an unknown suppressions shape",
      };
    if (
      page.resumeCursor.length > SUPPRESSION_PULL_CURSOR_MAX ||
      (page.nextCursor?.length ?? 0) > SUPPRESSION_PULL_CURSOR_MAX
    )
      return {
        ok: false,
        reason: "drovr cursor longer than the cursor column",
      };
    return { ok: true, page };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

type Database = {
  select: (fields: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (clause: unknown) => Promise<unknown[]> & {
        limit: (n: number) => Promise<unknown[]>;
      };
    };
  };
  insert: (table: unknown) => {
    values: (values: unknown) => {
      onDuplicateKeyUpdate: (config: { set: unknown }) => Promise<unknown>;
    };
  };
};

export function createDrizzleSuppressionPullStore(db: Database) {
  return {
    async readCursor(): Promise<string | undefined> {
      const rows = (await db
        .select({ cursor: contactSyncCursor.cursor })
        .from(contactSyncCursor)
        .where(eq(contactSyncCursor.name, SUPPRESSION_PULL_CURSOR_NAME))
        .limit(1)) as { cursor: string }[];
      const cursor = rows[0]?.cursor;
      return cursor ? cursor : undefined;
    },
    async writeCursor(cursor: string): Promise<void> {
      await db
        .insert(contactSyncCursor)
        .values({ name: SUPPRESSION_PULL_CURSOR_NAME, cursor })
        .onDuplicateKeyUpdate({ set: { cursor } });
    },
    async contactEmails(
      contactIds: readonly string[],
    ): Promise<Map<string, string>> {
      const emails = new Map<string, string>();
      if (contactIds.length === 0) return emails;
      const rows = (await db
        .select({ id: contact.id, email: contact.email })
        .from(contact)
        .where(inArray(contact.id, [...contactIds]))) as {
        id: string;
        email: string | null;
      }[];
      // A known contact with no email maps to '' so it is counted, not lost.
      for (const row of rows) emails.set(row.id, row.email ?? "");
      return emails;
    },
  };
}
