import { drizzle } from "drizzle-orm/mysql-proxy";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DrizzleCaptureMarketingRepository,
  LEARNER_FLOW_RECORD_PAGE_SIZE,
} from "./drizzle-capture-repository";

async function scan(
  intents: string[],
  entries: string[],
  pageSize: number,
  includeCanary = true,
) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const database = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    // Fail boundedly on cursor regressions rather than hanging a property run.
    expect(queries.length).toBeLessThanOrEqual(
      2 * (intents.length + entries.length + 2),
    );
    const isIntent = sql.includes("AI_SideEffectIntent");
    expect(sql).toMatch(/^select distinct `contactId` from/);
    expect(sql).toMatch(
      /order by `AI_(SideEffectIntent|ContactEvent)`\.`contactId` asc limit \?$/,
    );
    expect(params.at(-1)).toBe(pageSize);
    if (isIntent) {
      expect(sql).toContain("`provider` = ?");
      expect(sql).toContain("`type` = ?");
      expect(params.slice(0, 2)).toEqual(["kit", "send-value-path-email"]);
    } else {
      expect(sql).toContain("`eventType` = ?");
      expect(sql).toContain("`providerReference` in (");
      expect(params).toContain("value-path.entered");
      expect(params).toContain("value-path:ai-hero-skills-workflow");
    }
    const cursorClause = /`contactId` (>=|>) \?/.exec(sql);
    const cursor = cursorClause
      ? (params[
          sql.slice(0, cursorClause.index).split("?").length - 1
        ] as string)
      : undefined;
    if (queries.length > 2) {
      expect(cursorClause?.[1]).toBe(">");
    }
    const rows = [...new Set(isIntent ? intents : entries)]
      .sort()
      .filter(
        (id) =>
          cursor === undefined ||
          (cursorClause?.[1] === ">=" ? id >= cursor : id > cursor),
      )
      .slice(0, pageSize);
    return { rows: rows.map((id) => [id]) };
  });
  const repository = new DrizzleCaptureMarketingRepository(database);
  const ids = await repository["findSkillsWorkflowLearnerFlowContactIds"](
    { includeCanary },
    pageSize,
  );
  return { ids, queries };
}

// Contact IDs are generated from lowercase ASCII letters/digits in this repository.
const idSet = fc.array(
  fc.integer({ min: 0, max: 80 }).map((n) => `c${String(n).padStart(3, "0")}`),
  { maxLength: 100 },
);

describe("learner-flow membership keyset merge", () => {
  it("walks any two overlapping ID sets exactly once in ascending order", async () => {
    await fc.assert(
      fc.asyncProperty(
        idSet,
        idSet,
        fc.integer({ min: 1, max: 30 }),
        async (intents, entries, size) => {
          const { ids } = await scan(intents, entries, size);
          expect(ids).toEqual([...new Set([...intents, ...entries])].sort());
        },
      ),
      { numRuns: 250, seed: 20261026 },
    );
  });

  it.each([
    { intents: ["a", "b", "c", "d"], entries: ["b", "c", "e"], size: 2 },
    { intents: ["a", "z"], entries: ["b", "c", "d"], size: 2 },
    { intents: ["a"], entries: ["a"], size: 1 },
    { intents: [], entries: ["a", "b", "c"], size: 1 },
    { intents: ["a", "b", "c"], entries: [], size: 2 },
    { intents: [], entries: [], size: 3 },
  ])(
    "preserves overlap boundaries and exhausted sources: $intents / $entries",
    async ({ intents, entries, size }) => {
      const { ids } = await scan(intents, entries, size);
      expect(ids).toEqual([...new Set([...intents, ...entries])].sort());
    },
  );

  it("uses the same last-returned cursor on both tables across a production-sized overlap", async () => {
    const intents = Array.from(
      { length: 1600 },
      (_, n) => `c${String(n).padStart(5, "0")}`,
    );
    const entries = Array.from(
      { length: 1600 },
      (_, n) => `c${String(n + 500).padStart(5, "0")}`,
    );
    const { ids, queries } = await scan(
      intents,
      entries,
      LEARNER_FLOW_RECORD_PAGE_SIZE,
    );
    expect(ids).toEqual([...new Set([...intents, ...entries])].sort());
    expect(queries).toHaveLength(6);
    for (const query of queries.slice(2, 4))
      expect(query.params).toContain("c00999");
    for (const query of queries.slice(4, 6))
      expect(query.params).toContain("c01999");
  });

  it("retains canary exclusion on both source reads unless explicitly included", async () => {
    const excluded = await scan([], [], 3, false);
    const included = await scan([], [], 3, true);
    for (const query of excluded.queries)
      expect(query.sql).toContain("NOT EXISTS");
    for (const query of included.queries)
      expect(query.sql).not.toContain("NOT EXISTS");
  });
});
