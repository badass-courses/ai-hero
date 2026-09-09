import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readEvergreenPilotConfiguration,
  EVERGREEN_PILOT_LANDING_PATH,
} from "./evergreen-pilot-config";
import { pilotFixture } from "./evergreen-pilot.fixtures";
import {
  evergreenPilotClaim,
  runEvergreenPilotCommand,
  createEvergreenPilotEmailObservation,
} from "./evergreen-pilot";
import { createEvergreenClaimHttp } from "./evergreen-claim-http";
import { readFileSync } from "node:fs";

const { liveLoads } = vi.hoisted(() => ({ liveLoads: vi.fn() }));
vi.mock("./evergreen-pilot-live", () => {
  liveLoads();
  throw new Error("Disabled entrypoint acquired live dependencies");
});
afterEach(() => {
  expect(liveLoads).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
describe("bounded pilot entrypoints", () => {
  it.each([undefined, "", "{}", "{", "x".repeat(1_000_001)])(
    "default/invalid configuration refuses without acquiring dependencies",
    async (raw) => {
      vi.stubEnv("AIH_EVERGREEN_PILOT_CONFIG_JSON", raw ?? "");
      expect(readEvergreenPilotConfiguration(raw)).toBeNull();
      for (const method of ["GET", "POST"])
        expect(
          (
            await evergreenPilotClaim(
              new Request("https://example.test/api/evergreen/claim", {
                method,
              }),
            )
          ).status,
        ).toBe(404);
      expect(
        await runEvergreenPilotCommand({
          type: "scan",
          request: { generation: "test", lane: "source" },
        }),
      ).toEqual({ type: "Disabled" });
      const adapter = {};
      expect(createEvergreenPilotEmailObservation().wrapAdapter(adapter)).toBe(
        adapter,
      );
    },
  );
  it("accepts exact synthetic V3 but does not treat metadata as authority", () => {
    const f = pilotFixture();
    expect(f.config.journeyId).toBe(f.entry.decision.next.journeyId);
    expect(f.config.bundle.manifest.revision.definitionVersion).toBe(
      "evergreen-offer-v3",
    );
  });
  it.each([
    "missing-scope",
    "extra-contact",
    "unknown-revision",
    "unpublished",
    "body-mismatch",
    "extra-template",
    "unsafe-link",
    "wrong-control",
  ])("rejects %s before loading app", async (failure) => {
    const { value } = pilotFixture();
    const input: Record<string, unknown> = structuredClone(value);
    if (failure === "missing-scope") delete input.contactId;
    if (failure === "extra-contact") input.contacts = ["another"];
    if (failure === "unknown-revision")
      value.bundle.manifest.revision.definitionVersion = "evergreen-offer-v2";
    if (failure === "unpublished")
      value.bundle.providerReadbacks[0]!.published = false;
    if (failure === "body-mismatch")
      value.templates[0] = {
        ...value.templates[0]!,
        html: value.templates[0]!.html + "<p>changed</p>",
      };
    if (failure === "extra-template") value.templates.push(value.templates[0]!);
    if (failure === "unsafe-link")
      value.templates[0]!.links.OFFER_URL = "javascript:alert(1)";
    if (failure === "wrong-control") input.automationId = "newsletter-control";
    const raw = JSON.stringify(
      ["missing-scope", "extra-contact", "wrong-control"].includes(failure)
        ? input
        : value,
    );
    vi.stubEnv("AIH_EVERGREEN_PILOT_CONFIG_JSON", raw);
    expect(readEvergreenPilotConfiguration(raw)).toBeNull();
    expect(
      (
        await evergreenPilotClaim(
          new Request("https://example.test/api/evergreen/claim"),
        )
      ).status,
    ).toBe(404);
  });
  it("uses the actual workshop/product relationship and hides until authorized GET", () => {
    expect(EVERGREEN_PILOT_LANDING_PATH).toBe(
      "/workshops/ai-coding-crash-course",
    );
    const workshop = readFileSync(
      new URL("../app/(content)/workshops/[module]/page.tsx", import.meta.url),
      "utf8",
    );
    expect(workshop).toContain("getCachedWorkshopProduct(params.module)");
    expect(workshop).toContain("product?.id === 'product-ma254'");
    expect(workshop).toContain("pilotOnly");
    const products = readFileSync(
      new URL("../app/(commerce)/products/[slug]/page.tsx", import.meta.url),
      "utf8",
    );
    expect(products).not.toContain("EvergreenClaimPanel");
  });
  it("permits the real local workshop path, never traversal or an external return path", () => {
    const input = {
      enabled: false,
      origin: "https://example.test",
      secret: "",
      getSessionAndUser: async () => null,
      application: {
        status: async () => "unavailable" as const,
        claim: async () => "unavailable" as const,
      },
    };
    expect(() =>
      createEvergreenClaimHttp({
        ...input,
        productPath: EVERGREEN_PILOT_LANDING_PATH,
      }),
    ).not.toThrow();
    for (const productPath of [
      "/workshops/../login",
      "//evil.test",
      "/workshops/a?user=x",
    ])
      expect(() =>
        createEvergreenClaimHttp({ ...input, productPath }),
      ).toThrow();
  });
});
