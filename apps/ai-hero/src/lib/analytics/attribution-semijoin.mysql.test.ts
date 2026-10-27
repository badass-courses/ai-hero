import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql-proxy";
import {
  datetime,
  decimal,
  json,
  mysqlTable,
  text,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  createDatabaseProvider,
  type DatabaseAnalyticsSchema,
} from "@coursebuilder/analytics/providers/database";

const url = process.env.AIH_MYSQL_TEST_URL;
const purchases = mysqlTable("AI_Purchase", {
  id: varchar("id", { length: 191 }).primaryKey(),
  productId: varchar("productId", { length: 191 }),
  createdAt: datetime("createdAt"),
  status: varchar("status", { length: 191 }),
  totalAmount: decimal("totalAmount", { precision: 10, scale: 2 }),
  fields: json("fields"),
});
const shortlinkAttribution = mysqlTable("AI_ShortlinkAttribution", {
  type: varchar("type", { length: 191 }),
  metadata: text("metadata"),
});
// Only these tables are used by getAttributedRevenueSummary and its commerce summary.
const schema = { purchases, shortlinkAttribution } as DatabaseAnalyticsSchema;
const compact = (query: string) => query.replace(/\s+/g, " ").trim();
// Match the actual patched provider's SQL, not a test-only reimplementation.
const newSignal = compact(`\`AI_Purchase\`.\`id\` IN (
	SELECT pid FROM (
		SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(\`AI_ShortlinkAttribution\`.\`metadata\`, '$.purchaseId')) AS pid
		FROM \`AI_ShortlinkAttribution\`
		WHERE \`AI_ShortlinkAttribution\`.\`type\` = 'purchase'
			AND JSON_VALID(\`AI_ShortlinkAttribution\`.\`metadata\`)
	) AS attributed_purchase_ids
	WHERE pid IS NOT NULL
)`);
// The pre-patch correlated predicate, kept as an independent parity oracle.
const oldSignal = compact(`EXISTS (
	SELECT 1 FROM \`AI_ShortlinkAttribution\`
	WHERE \`AI_ShortlinkAttribution\`.\`type\` = 'purchase'
		AND JSON_VALID(\`AI_ShortlinkAttribution\`.\`metadata\`)
		AND JSON_UNQUOTE(JSON_EXTRACT(\`AI_ShortlinkAttribution\`.\`metadata\`, '$.purchaseId')) = \`AI_Purchase\`.\`id\`
)`);

const fixturePurchases = [
  ["strong", "10.11", { utmSource: "synthetic" }],
  ["strong-matched", "20.22", { attribution: { clickIds: ["synthetic"] } }],
  ["medium", "30.33", {}],
  ["medium-ga", "40.44", { gaClientId: "synthetic" }],
  ["medium-field", "15.15", { attribution: {} }],
  ["weak-ga", "50.55", { gaClientId: "synthetic" }],
  [
    "weak-report",
    "60.66",
    { attribution: { selfReportedSource: "synthetic" } },
  ],
  ["unknown", "70.77", {}],
  ["unknown-null-fields", "80.88", null],
  ["field-only", "90.99", { attribution: {} }],
  ["wrong-type", "12.34", {}],
] as const;
const matchedIds = ["strong-matched", "medium", "medium-ga", "medium-field"];

// Own disposable database only; never write to the URL's database or existing tables.
describe.skipIf(!url)(
  "analytics attribution semijoin (synthetic MySQL)",
  () => {
    let connection: Connection;
    let databaseName: string;
    beforeAll(async () => {
      const target = new URL(url!);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
        throw new Error("MySQL fixtures must be local");
      const prefix = target.pathname.slice(1).replace(/_app$/, "") || "aih";
      if (!/^[a-zA-Z0-9_]+$/.test(prefix))
        throw new Error("Invalid fixture database prefix");
      databaseName = `${prefix}_attr_${process.pid}_${Date.now()}`;
      connection = await mysql.createConnection({ uri: url!, timezone: "Z" });
      await connection.query(`CREATE DATABASE \`${databaseName}\``);
      await connection.query(`USE \`${databaseName}\``);
      await connection.query(`CREATE TABLE AI_Purchase (
			id VARCHAR(191) PRIMARY KEY, productId VARCHAR(191), createdAt DATETIME,
			status VARCHAR(191), totalAmount DECIMAL(10,2), fields JSON
		)`);
      // TEXT deliberately permits legacy invalid JSON and SQL NULL metadata.
      await connection.query(`CREATE TABLE AI_ShortlinkAttribution (
			type VARCHAR(191), metadata TEXT
		)`);
      for (const [id, amount, fields] of fixturePurchases)
        await connection.query(
          "INSERT INTO AI_Purchase VALUES (?, ?, ?, ?, ?, ?)",
          [
            id,
            "synthetic-product",
            "2026-01-01",
            "Valid",
            amount,
            fields === null ? null : JSON.stringify(fields),
          ],
        );
      for (const [id, status, amount, product] of [
        ["refunded", "Refunded", "100", "synthetic-product"],
        ["zero", "Valid", "0", "synthetic-product"],
        ["restricted", "Restricted", "5.55", "synthetic-product"],
        ["other-product", "Valid", "200", "synthetic-other"],
      ] as const)
        await connection.query(
          "INSERT INTO AI_Purchase VALUES (?, ?, ?, ?, ?, ?)",
          [id, product, "2026-01-01", status, amount, "{}"],
        );
    });
    afterAll(async () => {
      if (connection) {
        try {
          await connection.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
        } finally {
          await connection.end();
        }
      }
    });

    it.each([
      { name: "matches and duplicates", matches: true, noise: false },
      {
        name: "matches, missing ids, SQL NULL and invalid JSON",
        matches: true,
        noise: true,
      },
      { name: "empty attribution table", matches: false, noise: false },
      {
        name: "only missing ids, SQL NULL and invalid JSON",
        matches: false,
        noise: true,
      },
    ])(
      "$name preserves every sum and count, including negated buckets",
      async ({ matches, noise }) => {
        await connection.query("DELETE FROM AI_ShortlinkAttribution");
        if (matches) {
          for (const id of [
            ...matchedIds,
            "medium",
            "refunded",
            "zero",
            "other-product",
          ])
            await connection.query(
              "INSERT INTO AI_ShortlinkAttribution VALUES (?, ?)",
              ["purchase", JSON.stringify({ purchaseId: id })],
            );
        }
        if (noise) {
          for (const metadata of [
            "{}",
            '{"purchaseId":null}',
            null,
            "not json",
            "{",
            '{"purchaseId":"absent"}',
          ])
            await connection.query(
              "INSERT INTO AI_ShortlinkAttribution VALUES (?, ?)",
              ["purchase", metadata],
            );
          await connection.query(
            "INSERT INTO AI_ShortlinkAttribution VALUES (?, ?)",
            ["click", '{"purchaseId":"wrong-type"}'],
          );
        }

        let comparedQueries = 0;
        const affectedQueries: { query: string; params: unknown[] }[] = [];
        const db = drizzle(async (query, params) => {
          const current = compact(query);
          const baseline = current.replaceAll(newSignal, oldSignal);
          const [rows] = await connection.query(
            { sql: current, rowsAsArray: true },
            params,
          );
          const [oldRows] = await connection.query(
            { sql: baseline, rowsAsArray: true },
            params,
          );
          expect(rows, `Old/new parity: ${current}`).toEqual(oldRows);
          comparedQueries++;
          if (baseline !== current)
            affectedQueries.push({ query: current, params });
          return { rows: rows as unknown[][] };
        });
        const summary = await createDatabaseProvider(
          db,
          schema,
        ).getAttributedRevenueSummary("all", {
          productId: "synthetic-product",
        });
        expect(comparedQueries).toBe(20);
        // attributed, recovered, recovered signal, medium, weak and unknown.
        expect(affectedQueries).toHaveLength(6);
        expect(summary.paidPurchases).toBe(12);
        expect(summary.totalRevenue).toBeCloseTo(487.99);
        expect(summary.purchaseFieldAttributedPurchases).toBe(7);
        expect(summary.purchaseFieldAttributedRevenue).toBeCloseTo(288.12);
        expect(summary.recoveredFromShortlinkAttributionTablePurchases).toBe(
          matches ? 1 : 0,
        );
        expect(
          summary.recoveredFromShortlinkAttributionTableRevenue,
        ).toBeCloseTo(matches ? 30.33 : 0);
        const expected = matches
          ? {
              strong: [2, 30.33],
              medium: [3, 85.92],
              weak: [2, 111.21],
              unknown: [5, 260.53],
            }
          : {
              strong: [2, 30.33],
              medium: [0, 0],
              weak: [3, 151.65],
              unknown: [7, 306.01],
            };
        for (const [lane, [count, revenue]] of Object.entries(expected)) {
          const bucket = summary.quality[lane as keyof typeof summary.quality];
          expect(bucket.purchases, lane).toBe(count);
          expect(bucket.revenue, lane).toBeCloseTo(revenue!);
        }

        // Inspect real generated queries in both positive and negative contexts.
        // DISTINCT blocks derived-table merging even when IN is under OR / NOT.
        for (const { query, params } of affectedQueries) {
          const [rows] = await connection.query<RowDataPacket[]>(
            `EXPLAIN FORMAT=JSON ${query}`,
            params,
          );
          const plan = JSON.parse(rows[0]!.EXPLAIN);
          const materializations: Record<string, unknown>[] = [];
          const visit = (value: unknown) => {
            if (!value || typeof value !== "object") return;
            for (const [key, child] of Object.entries(value)) {
              if (key === "materialized_from_subquery")
                materializations.push(child);
              visit(child);
            }
          };
          visit(plan);
          expect(materializations.length, query).toBeGreaterThan(0);
          for (const materialization of materializations) {
            expect(materialization.dependent, query).toBe(false);
            expect(materialization.cacheable, query).toBe(true);
          }
        }
      },
    );
  },
);
