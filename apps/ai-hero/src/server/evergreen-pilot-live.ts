import { Effect } from "effect";
import { eq } from "drizzle-orm";
export { closeDatabasePool as closeEvergreenPilotPool } from "@/db";
import {
  acquireDatabaseConnection,
  createDatabaseHandle,
  courseBuilderAdapter,
} from "@/db";
import { contactEvent } from "@/db/schema";
import * as schema from "@/db/schema";
import { couponCommerceSchema } from "@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority-mysql";
import { env } from "@/env.mjs";
import {
  emailPreferenceDefinitionByKey,
  DEFAULT_EMAIL_PREFERENCE_KEY,
} from "@/coursebuilder/email-preferences";
import { AI_HERO_UNSUBSCRIBED_TAG_ID } from "@/lib/subscriber-marketing/ai-hero-email-opt-in";
import { restoreAutomationControl } from "@/lib/subscriber-marketing/email-course/restoration";
import { createDrizzleCurrentAuthorityRepository } from "@/lib/subscriber-marketing/evergreen-offer-journey/current-authority-repository";
import { createKitCurrentCommunicationReader } from "@/lib/subscriber-marketing/evergreen-offer-journey/current-authority";
import { createKitCommunicationTransport } from "@/lib/subscriber-marketing/evergreen-offer-journey/kit-communication-transport";
import { restoreSourceCandidate } from "@/lib/subscriber-marketing/evergreen-offer-journey/bounded-readers";
import type { BridgeControl } from "@/lib/subscriber-marketing/evergreen-offer-journey/bridge-runtime";
import { parseIsoInstant } from "@/lib/subscriber-marketing/evergreen-offer-journey/primitives";
import {
  createMySqlEmailObservationLeaseSource,
  createOwnedEmailObservationTransactions,
} from "@/lib/subscriber-marketing/evergreen-offer-journey/email-observation-transaction";
import { composeEvergreenPilot } from "./evergreen-pilot-application";
import type { EvergreenPilotConfiguration } from "./evergreen-pilot-config";

/** Loaded only after bounded private configuration has passed. Uses the existing
 * application pool, secrets and single-attempt adapters. No registration or sends here. */
export async function loadEvergreenPilot(config: EvergreenPilotConfiguration) {
  const database = createDatabaseHandle(schema),
    readback = createDatabaseHandle(schema);
  const repository = createDrizzleCurrentAuthorityRepository(database);
  const control = () =>
    Effect.tryPromise({
      try: async (): Promise<BridgeControl> => {
        const row = await repository.readControl(config.automationId);
        if (!row || row.automationId !== config.automationId)
          return { type: "Disabled" };
        const restored = restoreAutomationControl(row.control);
        if (!restored.ok || restored.value.type !== "Enabled")
          return { type: "Disabled" };
        if (restored.value.version !== config.generation)
          return { type: "Unavailable", reason: "PilotGenerationMismatch" };
        const rows = await database
          .select()
          .from(contactEvent)
          .where(eq(contactEvent.id, config.entryFactId))
          .limit(1);
        const source = restoreSourceCandidate(rows[0]);
        if (
          !source ||
          source.contactId !== config.contactId ||
          source.entryFactId !== config.entryFactId
        )
          return { type: "Unavailable", reason: "PilotSourceUnavailable" };
        return { type: "Enabled", generation: config.generation };
      },
      catch: () => ({
        type: "Unavailable" as const,
        reason: "PilotControlUnavailable",
      }),
    });
  const gate = await Effect.runPromise(control());
  if (gate.type !== "Enabled") return null;
  const apiKey = process.env.CONVERTKIT_V4_API_KEY;
  const secret = env.NEXTAUTH_SECRET;
  const getSessionAndUser =
    courseBuilderAdapter.getSessionAndUser?.bind(courseBuilderAdapter);
  if (!apiKey?.trim() || !secret?.trim() || !getSessionAndUser) return null;
  const nowDate = () => new Date(),
    now = () => nowDate().toISOString();
  const transport = createKitCommunicationTransport({
    apiKey,
    fetch,
    now: nowDate,
  });
  return composeEvergreenPilot(config, {
    origin: env.NEXT_PUBLIC_URL,
    getSessionAndUser,
    transactions: createOwnedEmailObservationTransactions(
      createMySqlEmailObservationLeaseSource({
        pool: { getConnection: acquireDatabaseConnection },
      }),
    ),
    observationReadback: readback,
    bridge: {
      database,
      commerceDatabase: createDatabaseHandle(couponCommerceSchema),
      ownerReadDatabase: readback,
      authorityDatabase: database,
      control,
      now,
      clock: {
        now: Effect.sync(() => {
          const value = parseIsoInstant(now());
          if (!value.ok) throw new Error("Invalid pilot clock");
          return value.value;
        }),
      },
      ownerProofSecret: secret,
      merchantCouponEvidence: config.merchantCouponEvidence,
      communication: createKitCurrentCommunicationReader({
        ...transport,
        preference:
          emailPreferenceDefinitionByKey[DEFAULT_EMAIL_PREFERENCE_KEY],
        exclusionTagId: AI_HERO_UNSUBSCRIBED_TAG_ID,
        now: nowDate,
      }),
      kit: {
        apiKey,
        fetch,
        resolveIdentity: async (contactId) => {
          if (contactId !== config.contactId)
            throw new Error("Outside pilot scope");
          const identity = await repository.readIdentity(contactId);
          if (
            identity.providers.length !== 1 ||
            identity.providers[0]?.contactId !== contactId ||
            identity.providers[0]?.provider !== "kit"
          )
            throw new Error("Pilot identity unavailable");
          return { contactId, subscriberId: identity.providers[0].externalId };
        },
      },
      messagePreparation: {
        templates: config.templates,
        apiSecret: env.CONVERTKIT_API_SECRET,
        readbackDatabase: readback,
      },
    },
  });
}
