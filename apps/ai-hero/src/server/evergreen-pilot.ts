import { getEvergreenPilotConfiguration } from "./evergreen-pilot-config";
import { pilotNotFound } from "./evergreen-pilot-application";
import { createVerifiedEmailObservation } from "./verified-email-observation";
import { runBoundedBridgeEvent } from "@/inngest/functions/evergreen-bridge-runtime";

let releaseCommandPool: (() => Promise<void>) | undefined;
/** CLI-only cleanup, never called by an HTTP/auth request. */
export async function closeEvergreenPilotCommand() {
  await releaseCommandPool?.();
}
export async function resolveEvergreenPilot() {
  const config = getEvergreenPilotConfiguration();
  if (!config) return null;
  const live = await import("./evergreen-pilot-live");
  releaseCommandPool = live.closeEvergreenPilotPool;
  return live.loadEvergreenPilot(config);
}
export async function evergreenPilotClaim(request: Request) {
  try {
    const app = await resolveEvergreenPilot();
    return app ? await app.claim(request) : pilotNotFound();
  } catch {
    return pilotNotFound();
  }
}
export async function resolveEvergreenPilotRuntime() {
  return (await resolveEvergreenPilot())?.runtime ?? null;
}
/** One explicit bounded invocation. No automatic continuation or retry. The
 * existing Inngest factory can use this same resolver after separate approval. */
export async function runEvergreenPilotCommand(input: unknown) {
  try {
    return await runBoundedBridgeEvent(resolveEvergreenPilotRuntime, input);
  } catch {
    return { type: "Unavailable" as const, reason: "PilotUnavailable" };
  }
}
export function createEvergreenPilotEmailObservation() {
  if (!getEvergreenPilotConfiguration())
    return createVerifiedEmailObservation({ enabled: false });
  return createVerifiedEmailObservation({
    enabled: true,
    providerId: "postmark",
    now: () => new Date(),
    writer: async (capture) => {
      // Unrelated auth retains its existing behavior, without new persistence.
      const config = getEvergreenPilotConfiguration();
      if (!config || capture.userId !== config.userId)
        return { type: "Unavailable" };
      const application = await resolveEvergreenPilot();
      return application
        ? application.observe(capture)
        : { type: "Unavailable" };
    },
  });
}
