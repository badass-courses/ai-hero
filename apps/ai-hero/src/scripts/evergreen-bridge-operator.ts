import { getEvergreenPilotConfiguration } from "@/server/evergreen-pilot-config";

/** Read-only inspection: no DB/provider/secret acquisition and no control write.
 * Configuration is not evidence that the persisted control permits execution. */
export function inspectEvergreenBridge() {
  const config = getEvergreenPilotConfiguration();
  return {
    type: config
      ? ("PilotConfiguredControlNotChecked" as const)
      : ("Disabled" as const),
    registration: "NotRegistered" as const,
    configuredRevisionCount: config ? 1 : 0,
    inngestMinimumIntervalMs: 1000,
    scanPageLimit: 1,
    messageRecoveryMaximumRows: 2,
    newsletterOwnership: "ExternalContinuity" as const,
    terminalHandoff: "HeldNotApplied" as const,
    requires: [
      "ReviewedV3PilotConfiguration",
      "CurrentAuthorityAndControl",
      "AcceptedSecureClaimReader",
      "ExactGenerationAndApproval",
      "ExplicitRegistrationAndActivationApproval",
    ],
    actions: ["inspect", "pilot <bounded-command-json>"],
    executionSurface:
      "pilot command: one bounded invocation; no global CLI throttle. Inngest registration remains separate (existing factory: concurrency 1, throttle 1s, retries 0).",
  };
}

if (process.argv[1]?.endsWith("evergreen-bridge-operator.ts")) {
  if (process.argv.length === 3 && process.argv[2] === "inspect") {
    console.log(JSON.stringify(inspectEvergreenBridge(), null, 2));
  } else if (
    process.argv.length === 4 &&
    process.argv[2] === "pilot" &&
    Buffer.byteLength(process.argv[3]!, "utf8") <= 4096
  ) {
    void (async () => {
      const pilot = await import("@/server/evergreen-pilot");
      try {
        console.log(
          JSON.stringify(
            await pilot.runEvergreenPilotCommand(JSON.parse(process.argv[3]!)),
          ),
        );
      } catch {
        console.error("Pilot command unavailable");
        process.exitCode = 1;
      } finally {
        await pilot.closeEvergreenPilotCommand();
      }
    })();
  } else {
    console.error(
      "Usage: evergreen-bridge-operator.ts inspect | pilot <bounded-command-json>",
    );
    process.exitCode = 1;
  }
}
