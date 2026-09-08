import { z } from "zod";
import { inspectBridgeConfiguration } from "@/lib/subscriber-marketing/evergreen-offer-journey/bridge-composition";
import { merchantEvidenceSchema } from "@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority";
import {
  compileMessageTemplate,
  reviewedMessageTemplateSchema,
} from "@/lib/subscriber-marketing/evergreen-offer-journey/message-preparation";
import { reviewedDeliveryBundleSchema } from "@/lib/subscriber-marketing/evergreen-offer-journey/revision-delivery";
import {
  deriveJourneyId,
  parseEntryFactId,
} from "@/lib/subscriber-marketing/evergreen-offer-journey/primitives";

export const EVERGREEN_PILOT_LANDING_PATH = "/workshops/ai-coding-crash-course";
const id = z.string().trim().min(1).max(255);
const schema = z
  .object({
    type: z.literal("Pilot"),
    automationId: z.literal("aihero-evergreen-pilot-v1"),
    generation: id.max(100),
    approvalReference: id,
    contactId: id,
    userId: id,
    entryFactId: id,
    bundle: reviewedDeliveryBundleSchema,
    templates: z.array(reviewedMessageTemplateSchema).length(8),
    merchantCouponEvidence: merchantEvidenceSchema.strict(),
  })
  .strict();
export type EvergreenPilotConfiguration = z.infer<typeof schema> & {
  journeyId: string;
};

/** Private server input only. Parsing is not approval. A separate persisted
 * control generation and explicit bounded invocation are required. Never log raw input. */
export function readEvergreenPilotConfiguration(
  raw: string | undefined,
): EvergreenPilotConfiguration | null {
  if (!raw || Buffer.byteLength(raw, "utf8") > 1_000_000) return null;
  try {
    const config = schema.parse(JSON.parse(raw));
    const entry = parseEntryFactId(config.entryFactId);
    if (
      !entry.ok ||
      inspectBridgeConfiguration({
        type: "Configured",
        generation: config.generation,
        approvalReference: config.approvalReference,
        bundles: [config.bundle],
      }).type !== "Configured"
    )
      return null;
    if (new Set(config.templates.map((t) => t.slot)).size !== 8) return null;
    for (const template of config.templates) {
      const compiled = compileMessageTemplate(template, {
        FIRST_NAME: "validation",
        REGULAR_PRICE: "validation",
        DISCOUNT_AMOUNT: "validation",
        DEADLINE_DISPLAY: "validation",
      });
      if (
        config.bundle.manifest.messages.find((m) => m.slotId === template.slot)
          ?.bodySha256 !== compiled.liquidHash
      )
        return null;
    }
    return { ...config, journeyId: deriveJourneyId(entry.value) };
  } catch {
    return null;
  }
}
export function getEvergreenPilotConfiguration() {
  return readEvergreenPilotConfiguration(
    process.env.AIH_EVERGREEN_PILOT_CONFIG_JSON,
  );
}
