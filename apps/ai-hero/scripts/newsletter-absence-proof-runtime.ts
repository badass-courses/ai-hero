import { homedir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  isContactStopped,
  readActiveContactStops,
} from "../src/lib/subscriber-marketing/contact-stop-rule";
import { readDrovrContactActor } from "../src/lib/subscriber-marketing/drovr-contact-actor";
import { drovrOutboxTarget } from "../src/lib/subscriber-marketing/drovr-outbox";
import { DROVR_CONTACT_DIRECTORY_JOURNEY_ID } from "../src/lib/subscriber-marketing/drovr-shadow-emitter";
import { resolveDrovrApiBaseUrl } from "../src/lib/subscriber-marketing/drovr-unsubscribe-page";
import { STOPPED_DIRECTORY_STATE } from "../src/lib/subscriber-marketing/owner-birth-guard";
import { RecoveryRefused } from "./held-exit-recover";
import { createHeldRecoveryPorts } from "./held-exit-recover-runtime";
import { withScanFile } from "./held-exit-scan-store";
import type {
  AbsenceProofArgs,
  AbsenceProofRuntime,
  AbsenceRecheckRuntime,
} from "./newsletter-absence-proof";
import { createKitAbsenceRecheck } from "./newsletter-absence-recheck";

/** Lazy, operator-only loader. The shared ports read; the only write port is createContactEvent.
 * Held-row and outbox reads belong to held-exit-recover and are never called here.
 * Write mode adds the per-reader rechecks: GETs to drovr and Kit, never a write. */
export async function createProductionAbsenceProofRuntime(
  mode: AbsenceProofArgs["mode"],
): Promise<{ runtime: AbsenceProofRuntime; close: () => Promise<void> }> {
  const apiKey = (
    process.env.KIT_V4_API_KEY ??
    process.env.CONVERTKIT_V4_API_KEY ??
    ""
  ).trim();
  if (!apiKey) throw new RecoveryRefused({ reason: "runtime-unavailable" });
  const drovr = {
    baseUrl: resolveDrovrApiBaseUrl({
      DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
      DROVR_SHADOW_INGEST_URL: process.env.DROVR_SHADOW_INGEST_URL,
    }),
    apiKey: process.env.DROVR_API_KEY_ORG_AIHERO?.trim() || undefined,
  };
  if (mode === "write" && (!drovr.baseUrl || !drovr.apiKey))
    throw new RecoveryRefused({ reason: "runtime-unavailable" });
  const [
    { db, closeDatabasePool },
    schema,
    { DrizzleCaptureMarketingRepository },
  ] = await Promise.all([
    import("../src/db"),
    import("../src/db/schema"),
    import("../src/lib/subscriber-marketing/drizzle-capture-repository"),
  ]);
  const repository = new DrizzleCaptureMarketingRepository(db);
  const target = drovrOutboxTarget({
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF,
  });
  const unused = async (): Promise<never> => {
    throw new RecoveryRefused({ reason: "runtime-unavailable" });
  };
  const runtime = createHeldRecoveryPorts({
    repository,
    apiKey,
    eventKey: "",
    fetch,
    now: () => new Date().toISOString(),
    withScanStore: (scope, action) =>
      withScanFile(
        join(homedir(), ".cache", "ai-hero", "held-exit", `${scope}.json`),
        action,
      ),
    deploymentScope: JSON.stringify({
      database: process.env.DATABASE_URL,
      target,
    }),
    findRows: async () => [],
    findKitIdentities: async (contactId) =>
      db
        .select({
          id: schema.providerIdentity.id,
          contactId: schema.providerIdentity.contactId,
          externalId: schema.providerIdentity.externalId,
        })
        .from(schema.providerIdentity)
        .where(
          and(
            eq(schema.providerIdentity.contactId, contactId),
            eq(schema.providerIdentity.provider, "kit"),
          ),
        )
        .limit(2),
    readOutbox: unused,
  });
  if (mode === "dry-run") return { runtime, close: closeDatabasePool };
  const recheck: AbsenceRecheckRuntime = {
    ...createKitAbsenceRecheck({ apiKey, fetch }),
    // The local stop rule first, then drovr's directory actor, the suppression authority.
    drovrStopped: async (contactId) => {
      if (isContactStopped(await readActiveContactStops(repository, contactId)))
        return true;
      const actor = await readDrovrContactActor({
        contactId,
        journeyId: DROVR_CONTACT_DIRECTORY_JOURNEY_ID,
        config: drovr,
      });
      if (!actor.ok)
        throw new RecoveryRefused({ reason: "recheck-unavailable" });
      return actor.found && STOPPED_DIRECTORY_STATE.test(actor.stateName);
    },
  };
  return { runtime: { ...runtime, recheck }, close: closeDatabasePool };
}
