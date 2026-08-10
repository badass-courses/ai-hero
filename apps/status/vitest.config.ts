import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_BEARER_TOKEN: "fixture-admin-token",
          DETECTOR_HMAC_SECRET: "fixture-detector-secret",
          STATUS_AUTOMATION_ENABLED: "true",
          STATUS_PUBLIC_WRITES_ENABLED: "true",
          TRACER_BEARER_TOKEN: "fixture-tracer-token",
          TRACER_ENABLED: "true",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
