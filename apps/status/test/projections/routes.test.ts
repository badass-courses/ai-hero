import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

describe("safe worker routes", () => {
  it("serves a noindex public page and anonymous projection with public caching", async () => {
    const page = await SELF.fetch("https://status.test/");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("public");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await page.text();
    expect(html).toContain("Status checks are not armed");
    expect(html).not.toContain("All systems operational");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toContain("—");

    const status = await SELF.fetch("https://status.test/status.json");
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toContain("public");
    const projection = (await status.json()) as {
      schemaVersion: string;
      overall: string;
      components: Array<{ key: string; state: string }>;
    };
    expect(projection).toMatchObject({
      schemaVersion: "aih.status.public.v1",
      overall: "unknown",
    });
    expect(projection).not.toMatchObject({ overall: "operational" });
    expect(projection.components.map((component) => component.key)).toEqual([
      "web",
      "auth",
      "checkout",
      "content",
      "learner_flow",
      "database",
      "email",
    ]);
    expect(projection.components.every((component) => component.state === "unknown")).toBe(true);
  });

  it("keeps the admin projection private and token protected", async () => {
    const denied = await SELF.fetch("https://status.test/admin/status.json");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("private, no-store");

    const allowed = await SELF.fetch("https://status.test/admin/status.json", {
      headers: { authorization: "Bearer fixture-admin-token" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("private, no-store");
    expect(await allowed.json()).toMatchObject({ schemaVersion: "aih.status.admin.v1" });
  });

  it("fails soft without making a false operational claim", async () => {
    const brokenEnv = {
      INCIDENTS: {
        getByName() {
          return {
            fetch() {
              throw new Error("fixture store failure");
            },
          };
        },
      },
      STATUS_AUTOMATION_ENABLED: "true",
      STATUS_PUBLIC_WRITES_ENABLED: "true",
      TRACER_ENABLED: "true",
    } as unknown as Env;
    const response = await worker.fetch(new Request("https://status.test/status.json"), brokenEnv);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("status_temporarily_unavailable");
    expect(body).not.toContain('"overall":"operational"');
  });

  it("returns 404 for unknown routes", async () => {
    expect((await SELF.fetch("https://status.test/nope")).status).toBe(404);
  });
});
