import { contactEvent } from "@/db/schema";
import { and, asc, eq, gt, gte, inArray, like, lte, or } from "drizzle-orm";

import { toContactEventRecord } from "./drizzle-capture-repository";
import { JOURNEY_OWNER_ASSIGNED_EVENT_TYPE } from "./drovr-ownership";
import {
  OWNER_BIRTH_GUARD_JOURNEY_ID,
  type OwnerBirthGuardPorts,
  type RepostOutcome,
} from "./owner-birth-guard";
import type { ContactEventRecord } from "./types";

/**
 * The guard's durable memory: one ContactEvent per owner whose birth it
 * re-posted, keyed by the owner event, so a key is re-posted at most once
 * ever. It maps to no drovr event.
 */
export const OWNER_BIRTH_REPOSTED_EVENT_TYPE = "drovr.owner-birth.reposted";

const STOP_EVENT_TYPES = [
  "contact.unsubscribed",
  "contact.bounced",
  "contact.complained",
] as const;

export const ownerBirthRepostProviderEventId = (ownerEventId: string) =>
  `drovr-owner-birth-repost:${ownerEventId}`;

export function ownerBirthRepostMarker(
  owner: ContactEventRecord,
  outcome: RepostOutcome,
  at: string,
): Omit<ContactEventRecord, "id" | "createdAt"> {
  const providerEventId = ownerBirthRepostProviderEventId(owner.id);
  return {
    contactId: owner.contactId,
    providerIdentityId: owner.providerIdentityId,
    provider: owner.provider,
    providerEventId,
    providerReference: owner.providerReference,
    eventType: OWNER_BIRTH_REPOSTED_EVENT_TYPE,
    occurredAt: at,
    semanticIdempotencyKey: providerEventId,
    privacyLevel: "internal",
    identityEvidence: owner.identityEvidence,
    payloadSummary: {
      summary: `The owner-without-birth guard re-posted ${owner.id}'s birth: ${outcome}`,
      keywords: [outcome],
      restrictedPayloadStored: false,
    },
    schemaVersion: owner.schemaVersion,
  };
}

type Select = {
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      where: (clause: unknown) => {
        orderBy: (...order: unknown[]) => {
          limit: (n: number) => Promise<unknown[]>;
        };
      } & Promise<unknown[]>;
    };
  };
};

/**
 * The guard's reads. The owner scan rides
 * ContactEvent_eventType_occurredAt_id_idx and pages by (occurredAt, id);
 * the stop and marker reads ride ContactEvent_contactId_idx.
 */
export function createDrizzleOwnerBirthGuardStore(
  // The same shape the capture repository takes; this only selects.
  database: unknown,
): Pick<
  OwnerBirthGuardPorts,
  "scanOwners" | "stoppedContactIds" | "repostedOwnerEventIds"
> {
  const db = database as Select;
  return {
    async scanOwners({ from, to, after, limit }) {
      const cursor = after ? new Date(after.occurredAt) : undefined;
      const rows = await db
        .select()
        .from(contactEvent)
        .where(
          and(
            eq(contactEvent.eventType, JOURNEY_OWNER_ASSIGNED_EVENT_TYPE),
            gte(contactEvent.occurredAt, new Date(from)),
            lte(contactEvent.occurredAt, new Date(to)),
            cursor && after
              ? or(
                  gt(contactEvent.occurredAt, cursor),
                  and(
                    eq(contactEvent.occurredAt, cursor),
                    gt(contactEvent.id, after.id),
                  ),
                )
              : undefined,
            like(
              contactEvent.providerEventId,
              `%:${OWNER_BIRTH_GUARD_JOURNEY_ID}`,
            ),
          ),
        )
        .orderBy(asc(contactEvent.occurredAt), asc(contactEvent.id))
        .limit(limit);
      return rows.map(toContactEventRecord);
    },
    async stoppedContactIds(contactIds) {
      if (contactIds.length === 0) return new Set();
      const rows = (await db
        .select({ contactId: contactEvent.contactId })
        .from(contactEvent)
        .where(
          and(
            inArray(contactEvent.contactId, [...contactIds]),
            inArray(contactEvent.eventType, [...STOP_EVENT_TYPES]),
          ),
        )) as { contactId: string }[];
      return new Set(rows.map((row) => row.contactId));
    },
    async repostedOwnerEventIds(owners) {
      if (owners.length === 0) return new Set();
      const rows = (await db
        .select({ providerEventId: contactEvent.providerEventId })
        .from(contactEvent)
        .where(
          and(
            inArray(contactEvent.contactId, [
              ...new Set(owners.map((owner) => owner.contactId)),
            ]),
            eq(contactEvent.eventType, OWNER_BIRTH_REPOSTED_EVENT_TYPE),
          ),
        )) as { providerEventId: string }[];
      const markers = new Set(rows.map((row) => row.providerEventId));
      return new Set(
        owners
          .filter((owner) =>
            markers.has(ownerBirthRepostProviderEventId(owner.id)),
          )
          .map((owner) => owner.id),
      );
    },
  };
}
