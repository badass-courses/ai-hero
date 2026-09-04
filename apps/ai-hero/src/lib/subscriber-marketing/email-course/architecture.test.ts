import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("email course module boundary", () => {
  it("keeps provider, transport, rollout, and legacy path vocabulary outside", async () => {
    const directory = path.dirname(new URL(import.meta.url).pathname);
    const files = (await fs.readdir(directory)).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await fs.readFile(path.join(directory, file), "utf8"),
      })),
    );
    const forbidden = /\b(?:convertkit|inngest|kit|redis|gate-d)\b/i;
    const violations = sources.flatMap(({ file, source }) =>
      forbidden.test(source) ? [file] : [],
    );
    const outwardImports = sources.flatMap(({ file, source }) =>
      /from\s+["']\.\.\//.test(source) ? [file] : [],
    );
    const publicBarrel = sources.find(
      ({ file }) => file === "index.ts",
    )?.source;

    expect(violations).toEqual([]);
    expect(outwardImports).toEqual([]);
    expect(publicBarrel).not.toContain("export *");
  });
});
