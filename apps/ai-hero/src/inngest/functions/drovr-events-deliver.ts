import { env } from "@/env.mjs";
import { DROVR_EVENTS_DELIVER_EVENT } from "@/inngest/events/drovr";
import { inngest } from "@/inngest/inngest.server";
import { deliverOrThrow } from "@/lib/subscriber-marketing/drovr-shadow-delivery";
import type { DrovrDeliveryConfig } from "@/lib/subscriber-marketing/drovr-shadow-emitter";

export type DrovrEventsDeliverReceipt = {
  status: "delivered" | "skipped";
  accepted: number;
  rejected: number;
  reason?: string;
};

/**
 * Durable delivery of drovr events. Each event is its own step keyed by
 * the drovr idempotency key, so a retry after a partial batch never
 * re-posts what already landed, and drovr dedupes anything that does
 * repeat. Concurrency stays modest: drovr's ingress is one D1 append and
 * one Durable Object fold per event.
 */
export const drovrEventsDeliver = inngest.createFunction(
  {
    id: "drovr-events-deliver-v1",
    name: "drovr: deliver events durably",
    retries: 6,
    concurrency: { limit: 8 },
  },
  { event: DROVR_EVENTS_DELIVER_EVENT },
  async ({ event, step }): Promise<DrovrEventsDeliverReceipt> => {
    const ingestUrl = env.DROVR_SHADOW_INGEST_URL;
    const apiKey = env.DROVR_SHADOW_API_KEY;
    if (!ingestUrl || !apiKey) {
      return {
        status: "skipped",
        accepted: 0,
        rejected: 0,
        reason: "drovr ingest is not configured",
      };
    }
    const config: DrovrDeliveryConfig = { ingestUrl, apiKey };

    let accepted = 0;
    let rejected = 0;
    for (const drovrEvent of event.data.events) {
      const outcome = await step.run(
        `deliver:${drovrEvent.idempotencyKey}`,
        () => deliverOrThrow({ event: drovrEvent, config }),
      );
      if (outcome.status === "accepted") accepted += 1;
      if (outcome.status === "rejected") rejected += 1;
    }
    return { status: "delivered", accepted, rejected };
  },
);
