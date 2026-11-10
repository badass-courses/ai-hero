import { inngest } from "@/inngest/inngest.server";

/**
 * drovr -> ai-hero stops, every 5 minutes, one run at a time. Dark until
 * AIH_DROVR_SUPPRESSION_PULL_ENABLED is 'true'. See
 * lib/subscriber-marketing/drovr-suppression-pull.ts.
 */
export const drovrSuppressionPull = inngest.createFunction(
  {
    id: "drovr-suppression-pull-v1",
    name: "drovr: pull suppressions into the ContactEvent stop log",
    retries: 3,
    concurrency: [{ limit: 1 }],
    singleton: { mode: "skip" },
    timeouts: { finish: "4m" },
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const [
      { db },
      { env },
      { log },
      { runSuppressionPull },
      { createDrizzleSuppressionPullStore, readDrovrSuppressions },
      { drovrApiKeyForTenant, DROVR_AUTHORITY_TENANT_ID },
      { resolveDrovrApiBaseUrl },
    ] = await Promise.all([
      import("@/db"),
      import("@/env.mjs"),
      import("@/server/logger"),
      import("@/lib/subscriber-marketing/drovr-suppression-pull"),
      import("@/lib/subscriber-marketing/drovr-suppression-pull-live"),
      import("@/lib/subscriber-marketing/drovr-shadow-emitter"),
      import("@/lib/subscriber-marketing/drovr-unsubscribe-page"),
    ]);
    if (env.AIH_DROVR_SUPPRESSION_PULL_ENABLED !== "true")
      return { status: "skipped", reason: "flag-off" };
    const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID);
    const baseUrl = resolveDrovrApiBaseUrl({
      DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
      DROVR_SHADOW_INGEST_URL: env.DROVR_SHADOW_INGEST_URL,
    });
    if (!apiKey || !baseUrl) {
      await log.error("drovr.suppression_pull.not_configured", {
        missing: "DROVR_API_BASE_URL or DROVR_API_KEY_ORG_AIHERO",
      });
      return { status: "skipped", reason: "drovr-not-configured" };
    }
    const receipt = await step.run("pull-suppressions", async () => {
      const store = createDrizzleSuppressionPullStore(db as never);
      return runSuppressionPull({
        readCursor: store.readCursor,
        writeCursor: store.writeCursor,
        contactEmails: store.contactEmails,
        readPage: (at) =>
          readDrovrSuppressions({ at, config: { baseUrl, apiKey } }),
        send: async (events) => {
          await inngest.send(events);
        },
      });
    });
    const fields = {
      status: receipt.status,
      reason: receipt.reason,
      ...receipt.counts,
    };
    if (receipt.status === "failed")
      await log.warn("drovr.suppression_pull.completed", fields);
    else await log.info("drovr.suppression_pull.completed", fields);
    return receipt;
  },
);
