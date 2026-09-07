import { drizzle } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createDrizzleCurrentAuthorityRepository } from "./current-authority-repository";

function fixture() {
  const query = vi.fn(async (options: { sql: string }, _params: unknown[]) => [
    options.sql.includes("from `AI_ContentResourceProduct`")
      ? [["course"]]
      : [],
    [],
  ]);
  // HTTP/SQL-free mysql2 boundary: Drizzle still builds and executes its real SELECTs.
  const database = drizzle({
    client: { query } as unknown as Pool,
    schema,
    mode: "default",
  });
  return {
    repository: createDrizzleCurrentAuthorityRepository(database),
    query,
  };
}

describe("current authority SELECT boundaries", () => {
  it("reads the exact control key without writes or default enabled state", async () => {
    const f = fixture();
    expect(await f.repository.readControl("exact-automation")).toBeNull();
    expect(f.query).toHaveBeenCalledTimes(1);
    const [statement, params] = f.query.mock.calls[0]!;
    expect(statement.sql).toMatch(/^select /i);
    expect(statement.sql).toContain(
      "`AI_AutomationControl`.`automationId` = ?",
    );
    expect(statement.sql).toContain("limit ?");
    expect(params).toEqual(["exact-automation", 1]);
  });
  it("uses two unique source keys and at most two indexed journey heads", async () => {
    const f = fixture();
    await f.repository.readExhaustionFacts(["individual-key", "team-key"]);
    await f.repository.readJourneyHeads(["journey-one", "journey-two"]);
    expect(f.query.mock.calls).toHaveLength(3);
    expect(f.query.mock.calls[0]![0].sql).toContain(
      "semanticIdempotencyKey` in (?, ?)",
    );
    expect(f.query.mock.calls[0]![1]).toEqual([
      "individual-key",
      "team-key",
      2,
    ]);
    for (const [statement, params] of f.query.mock.calls.slice(1)) {
      expect(statement.sql).toContain("journeyId` = ?");
      expect(statement.sql).toContain("actorVersion` desc limit ?");
      expect(params[1]).toBe(1);
    }
    await expect(
      f.repository.readJourneyHeads(["1", "2", "3"]),
    ).rejects.toThrow("bound");
    expect(f.query.mock.calls).toHaveLength(3);
  });
  it("scopes direct purchases and personal/team access without full-history materialization", async () => {
    const f = fixture();
    await f.repository.readPurchases(
      "user-test",
      new Date("2026-09-07T19:00:00.000Z"),
    );
    expect(f.query.mock.calls).toHaveLength(4);
    const direct = f.query.mock.calls[0]!;
    expect(direct[1]).toEqual([
      "user-test",
      "product-ma254",
      "Valid",
      "Restricted",
      1,
    ]);
    expect(f.query.mock.calls[1]![1]).toEqual(["product-ma254", 1]);
    for (const [statement, params] of f.query.mock.calls.slice(2)) {
      expect(statement.sql).toContain("JSON_CONTAINS");
      expect(statement.sql).toContain("deletedAt` is null");
      expect(statement.sql).toContain("expiresAt` > ?");
      expect(statement.sql).toContain("limit ?");
      expect(params).toContain("user-test");
      expect(params).toContain("product-ma254");
      expect(params.at(-1)).toBe(1);
    }
    expect(f.query.mock.calls[3]![0].sql).toContain(
      "organizationMembershipId` =",
    );
    expect(f.query.mock.calls[3]![0].sql).not.toContain("organizationId` =");
    expect(
      f.query.mock.calls.every(([statement]) =>
        /^select /i.test(statement.sql),
      ),
    ).toBe(true);
  });
});
