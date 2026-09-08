import { describe, it, expect } from "vitest";
import {
  inspectBridgeConfiguration,
  type BridgeConfiguration,
} from "./bridge-composition";
import { syntheticRevisionScope } from "./revision-delivery.fixtures";
import {
  EVERGREEN_OFFER_JOURNEY_V1,
  EVERGREEN_OFFER_JOURNEY_V2,
} from "./definition";
function bundle(
  definition: Parameters<
    typeof syntheticRevisionScope
  >[0] = EVERGREEN_OFFER_JOURNEY_V2,
) {
  const manifest = syntheticRevisionScope(definition).manifest;
  return {
    manifest,
    providerReadbacks: manifest.messages.map((m) => ({
      sequenceId: m.sequenceId,
      repeat: false as const,
      emailCount: 1 as const,
      published: true as const,
      active: true as const,
      hold: false as const,
    })),
  };
}
function inspect(bundles: unknown) {
  return inspectBridgeConfiguration({
    type: "Configured",
    generation: "test",
    approvalReference: "fixture-not-production-approval",
    bundles,
  } as BridgeConfiguration);
}
describe("V2 required; separately reviewed V1 optional", () => {
  it("accepts reviewed V2 alone and optional V1 pair", () => {
    expect(inspect([bundle()]).type).toBe("Configured");
    expect(inspect([bundle(EVERGREEN_OFFER_JOURNEY_V1), bundle()]).type).toBe(
      "Configured",
    );
  });
  it.each([
    "empty",
    "legacy-only",
    "duplicate-v2",
    "excess",
    "unknown",
    "malformed",
    "unpublished",
    "missing-readback",
  ])("refuses %s", (kind) => {
    const v2 = bundle();
    const candidates: Record<string, unknown> = {
      empty: [],
      "legacy-only": [bundle(EVERGREEN_OFFER_JOURNEY_V1)],
      "duplicate-v2": [v2, v2],
      excess: [v2, v2, v2],
      unknown: [
        {
          ...v2,
          manifest: {
            ...v2.manifest,
            revision: {
              ...v2.manifest.revision,
              definitionVersion: "evergreen-offer-v3",
            },
          },
        },
      ],
      malformed: [{}],
      unpublished: [
        {
          ...v2,
          providerReadbacks: v2.providerReadbacks.map((r) => ({
            ...r,
            published: false,
          })),
        },
      ],
      "missing-readback": [
        { ...v2, providerReadbacks: v2.providerReadbacks.slice(1) },
      ],
    };
    expect(inspect(candidates[kind]).type).toBe("Unavailable");
  });
});
