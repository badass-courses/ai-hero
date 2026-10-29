import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { providerIdentity } from "@/db/schema";
import { env } from "@/env.mjs";
import { DrizzleCaptureMarketingRepository } from "@/lib/subscriber-marketing/drizzle-capture-repository";
import { parseDrovrSignupDeliveryConfig } from "@/lib/subscriber-marketing/drovr-doi-signup";
import { readDrovrOptOuts } from "@/lib/subscriber-marketing/drovr-opt-out-reader";

import type { RecoveryStandingReader } from "./recovery-standing";

/**
 * Dark until `AIH_SUPPORT_RECOVERY_LOCAL_STANDING=true`: lesson-one recovery
 * keeps asking Kit until the flag moves.
 */
export function recoveryLocalStandingEnabled() {
  return process.env.AIH_SUPPORT_RECOVERY_LOCAL_STANDING === "true";
}

export function createRecoveryStandingReader(): RecoveryStandingReader {
  const repository = new DrizzleCaptureMarketingRepository(db);
  const drovrConfig = parseDrovrSignupDeliveryConfig(env);
  return {
    findContactByEmail: (email) => repository.findContactByEmail(email),
    async findKitSubscriberIds(contactId) {
      const rows = await db
        .select({ externalId: providerIdentity.externalId })
        .from(providerIdentity)
        .where(
          and(
            eq(providerIdentity.contactId, contactId),
            eq(providerIdentity.provider, "kit"),
          ),
        );
      return [...new Set(rows.map((row) => row.externalId))];
    },
    findContactEventsByType: (contactId, eventType) =>
      repository.findContactEventsByType(contactId, eventType),
    readDrovrStops: (kitSubscriberId) =>
      readDrovrOptOuts(kitSubscriberId, drovrConfig),
  };
}
