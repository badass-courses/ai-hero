import { preparationFixture } from "@/lib/subscriber-marketing/evergreen-offer-journey/message-preparation.fixtures";
import { readEvergreenPilotConfiguration } from "./evergreen-pilot-config";

/** Synthetic only; never imported by an application entrypoint. */
export function pilotFixture() {
  const f = preparationFixture();
  const value = {
    type: "Pilot",
    automationId: "aihero-evergreen-pilot-v1",
    generation: "synthetic-pilot",
    approvalReference: "synthetic-not-approval",
    contactId: f.entry.decision.next.contactId,
    userId: "synthetic-pilot-user",
    entryFactId:
      f.entry.stimulus.type === "CourseSequenceExhausted"
        ? f.entry.stimulus.entryFactId
        : "",
    templates: f.templates,
    bundle: {
      manifest: f.manifest,
      providerReadbacks: f.manifest.messages.map((m) => ({
        sequenceId: m.sequenceId,
        repeat: false,
        emailCount: 1,
        published: true,
        active: true,
        hold: false,
      })),
    },
    merchantCouponEvidence: {
      id: "pilot-merchant",
      identifier: "synthetic",
      merchantAccountId: "synthetic",
      currency: "USD",
      amountOffCents: 10000,
      type: "special",
      sourceReference: "synthetic-not-provider-proof",
    },
  };
  const config = readEvergreenPilotConfiguration(JSON.stringify(value));
  if (!config) throw new Error("Invalid synthetic pilot configuration");
  return { ...f, config, value };
}
