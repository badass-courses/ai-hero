import { describe, expect, it, vi } from "vitest";
import { buyPathOrigin } from "./origin";
import { ingestBuyPath } from "./ingest";
const production = {
  publicUrl: "https://www.aihero.dev",
  vercelEnvironment: "production",
  vercelDeploymentHost: "production-deployment.vercel.app",
};
const body = JSON.stringify({
  buyPathId: "cs_test_fixture",
  step: "client_returned",
  outcome: "ok",
  durationMs: 0,
});
async function ingest(origin: string | undefined, configured: string | null) {
  const deps = {
    origin: configured,
    limit: vi.fn(async () => true),
    context: vi.fn(async () => ({
      buyPathId: "cs_test_fixture",
      purchaseId: null,
      productId: "product_fixture",
      userId: null,
    })),
    emit: vi.fn(),
  };
  const response = await ingestBuyPath(
    new Request("http://localhost:3000/api/telemetry/buy-path", {
      method: "POST",
      headers: {
        ...(origin !== undefined ? { origin } : {}),
        host: "www.aihero.dev",
        "x-forwarded-host": "www.aihero.dev",
      },
      body,
    }),
    deps,
  );
  return { response, deps };
}
describe("exact configured browser origin", () => {
  it("accepts production www, independent of Vercel deployment hostname", async () => {
    expect(buyPathOrigin(production)).toBe("https://www.aihero.dev");
    expect(
      (await ingest("https://www.aihero.dev", buyPathOrigin(production)))
        .response.status,
    ).toBe(204);
  });
  it.each([
    ["apex", "https://aihero.dev"],
    ["other host", "https://other.example"],
    ["suffix host", "https://www.aihero.dev.attacker.example"],
    ["wrong scheme", "http://www.aihero.dev"],
    ["wrong port", "https://www.aihero.dev:8443"],
    ["missing", undefined],
    ["opaque null", "null"],
  ])(
    "rejects %s before credentials or body processing",
    async (_name, origin) => {
      const { response, deps } = await ingest(
        origin,
        buyPathOrigin(production),
      );
      expect(response.status).toBe(403);
      expect(deps.limit).not.toHaveBeenCalled();
      expect(deps.emit).not.toHaveBeenCalled();
    },
  );
  it("binds a preview to its platform URL, never the production URL", async () => {
    const origin = buyPathOrigin({
      ...production,
      vercelEnvironment: "preview",
      vercelDeploymentHost: "preview-fixture.vercel.app",
    });
    expect(origin).toBe("https://preview-fixture.vercel.app");
    expect(
      (await ingest("https://preview-fixture.vercel.app", origin)).response
        .status,
    ).toBe(204);
    expect(
      (await ingest("https://www.aihero.dev", origin)).response.status,
    ).toBe(403);
  });
  it("fails closed on missing or malformed preview host and invalid canonical config", async () => {
    for (const host of [
      undefined,
      "",
      "evil.example/path",
      "https://evil.example",
    ]) {
      const origin = buyPathOrigin({
        ...production,
        vercelEnvironment: "preview",
        vercelDeploymentHost: host,
      });
      expect(origin).toBeNull();
      expect(
        (await ingest("https://www.aihero.dev", origin)).response.status,
      ).toBe(403);
    }
    for (const publicUrl of [
      undefined,
      "",
      "null",
      "ftp://www.aihero.dev",
      "https://user:password@www.aihero.dev",
    ])
      expect(buyPathOrigin({ publicUrl })).toBeNull();
  });
  it("uses the configured local scheme, host and non-default port", async () => {
    const origin = buyPathOrigin({
      publicUrl: "http://127.0.0.1:3350",
      vercelEnvironment: "development",
    });
    expect(
      (await ingest("http://127.0.0.1:3350", origin)).response.status,
    ).toBe(204);
    expect(
      (await ingest("http://127.0.0.1:3351", origin)).response.status,
    ).toBe(403);
  });
});
