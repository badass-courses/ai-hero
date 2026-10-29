import { homedir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { drovrOutboxTarget } from "../src/lib/subscriber-marketing/drovr-outbox";
import { RecoveryRefused } from "./held-exit-recover";
import { createHeldRecoveryPorts } from "./held-exit-recover-runtime";
import { withScanFile } from "./held-exit-scan-store";
import type {
  AbsenceProofArgs,
  AbsenceProofRuntime,
} from "./newsletter-absence-proof";

/** Lazy, operator-only loader. The shared ports read; the only write port is createContactEvent.
 * Held-row and outbox reads belong to held-exit-recover and are never called here. */
export async function createProductionAbsenceProofRuntime(
  _mode: AbsenceProofArgs["mode"],
): Promise<{ runtime: AbsenceProofRuntime; close: () => Promise<void> }> {
  const apiKey = (
    process.env.KIT_V4_API_KEY ??
    process.env.CONVERTKIT_V4_API_KEY ??
    ""
  ).trim();
  if (!apiKey) throw new RecoveryRefused({ reason: "runtime-unavailable" });
  const [
    { db, closeDatabasePool },
    schema,
    { DrizzleCaptureMarketingRepository },
  ] = await Promise.all([
    import("../src/db"),
    import("../src/db/schema"),
    import("../src/lib/subscriber-marketing/drizzle-capture-repository"),
  ]);
  const target = drovrOutboxTarget({
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF,
  });
  const unused = async (): Promise<never> => {
    throw new RecoveryRefused({ reason: "runtime-unavailable" });
  };
  const runtime = createHeldRecoveryPorts({
    repository: new DrizzleCaptureMarketingRepository(db),
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
  return { runtime, close: closeDatabasePool };
}
