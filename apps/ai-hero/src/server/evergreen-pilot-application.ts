import { Effect } from "effect";
import { createBridgeComposition } from "@/lib/subscriber-marketing/evergreen-offer-journey/bridge-composition";
import { createEmailTokenLoginObservationWriter } from "@/lib/subscriber-marketing/evergreen-offer-journey/email-token-login-observation-mysql";
import { createVerifiedUserObservedSource } from "@/lib/subscriber-marketing/evergreen-offer-journey/verified-user-observed-source";
import { createEvergreenClaimHttp } from "./evergreen-claim-http";
import type { EmailLoginCapture } from "./verified-email-observation";
import {
  EVERGREEN_PILOT_LANDING_PATH,
  type EvergreenPilotConfiguration,
} from "./evergreen-pilot-config";

type BridgeInput = Parameters<typeof createBridgeComposition>[0];
type WriterInput = Parameters<typeof createEmailTokenLoginObservationWriter>[0];
export function composeEvergreenPilot(
  config: EvergreenPilotConfiguration,
  input: {
    bridge: Omit<BridgeInput, "config" | "scope" | "automationId">;
    transactions: WriterInput["transactions"];
    observationReadback: WriterInput["readbackDatabase"];
    origin: string;
    getSessionAndUser: Parameters<
      typeof createEvergreenClaimHttp
    >[0]["getSessionAndUser"];
  },
) {
  const scope = {
    contactId: config.contactId,
    userId: config.userId,
    entryFactId: config.entryFactId,
    journeyId: config.journeyId,
  };
  const assembled = createBridgeComposition({
    ...input.bridge,
    scope,
    automationId: config.automationId,
    config: {
      type: "Configured",
      generation: config.generation,
      approvalReference: config.approvalReference,
      bundles: [config.bundle],
    },
  });
  if (assembled.type !== "Configured") return null;
  const permitted = async () => {
    const result = await Effect.runPromise(input.bridge.control());
    return result.type === "Enabled" && result.generation === config.generation;
  };
  const now = () => new Date(input.bridge.now());
  const application = createVerifiedUserObservedSource({
    scope,
    transactions: input.transactions,
    readback: input.observationReadback,
    ledger: assembled.ledger,
    authority: assembled.authority,
    service: assembled.service,
    secret: input.bridge.ownerProofSecret,
    now,
  });
  const claim = createEvergreenClaimHttp({
    enabled: true,
    origin: input.origin,
    productPath: EVERGREEN_PILOT_LANDING_PATH,
    secret: input.bridge.ownerProofSecret,
    now,
    application,
    getSessionAndUser: async (token) => {
      const result = await input.getSessionAndUser(token);
      return result?.user.id === config.userId ? result : null;
    },
  });
  const observe = createEmailTokenLoginObservationWriter({
    database: input.bridge.database,
    scope,
    transactions: input.transactions,
    readbackDatabase: input.observationReadback,
    secret: input.bridge.ownerProofSecret,
    now,
  });
  return {
    runtime: assembled.runtime,
    async claim(request: Request) {
      return (await permitted()) ? claim(request) : pilotNotFound();
    },
    async observe(capture: EmailLoginCapture) {
      if (capture.userId !== config.userId || !(await permitted()))
        return { type: "Unavailable" as const };
      return observe(capture);
    },
  };
}
export function pilotNotFound() {
  return new Response(null, {
    status: 404,
    headers: {
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
      "Referrer-Policy": "no-referrer",
    },
  });
}
