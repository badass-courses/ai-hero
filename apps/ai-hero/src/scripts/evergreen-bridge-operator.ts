import { PRODUCTION_DELIVERY_BUNDLES } from "@/lib/subscriber-marketing/evergreen-offer-journey/revision-delivery";

/** Read-only operator surface. No DB, Redis, provider client, environment flag or
 * composition import. A separate reviewed registration supplies real capabilities.
 */
export function inspectEvergreenBridge() {
  return {
    type: "Disabled" as const,
    registration: "NotRegistered" as const,
    configuredRevisionCount: PRODUCTION_DELIVERY_BUNDLES.length,
    minimumIntervalMs: 1000,
    scanPageLimit: 1,
    messageRecoveryMaximumRows: 2,
    newsletterOwnership: "ExternalContinuity" as const,
    terminalHandoff: "HeldNotApplied" as const,
    requires: [
      "ReviewedV1AndV2ProviderBindings",
      "CurrentAuthorityAndControl",
      "AcceptedSecureClaimReader",
      "ExactGenerationAndApproval",
      "ExplicitRegistrationAndActivationApproval",
    ],
    actions: ["inspect"],
    executionSurface:
      "createEvergreenBridgeRuntimeFunction or runBridgeRuntimeCommand; never auto-registered",
  };
}

if (process.argv[1]?.endsWith("evergreen-bridge-operator.ts")) {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== "inspect") {
    console.error(
      "Usage: tsx src/scripts/evergreen-bridge-operator.ts inspect (read-only; no activation command)",
    );
    process.exitCode = 1;
  } else console.log(JSON.stringify(inspectEvergreenBridge(), null, 2));
}
