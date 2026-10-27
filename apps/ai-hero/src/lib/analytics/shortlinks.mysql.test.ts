import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql, { type Connection } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql-proxy";

vi.mock("@/db", () => ({ db: {} }));
import { getShortlinkPerformance } from "./providers/database";

const url = process.env.AIH_MYSQL_TEST_URL;

// Own disposable database only. Never modify the URL's database or existing tables.
describe.skipIf(!url)(
  "dashboard shortlink performance (synthetic MySQL)",
  () => {
    let connection: Connection;
    let databaseName: string;
    let database: ReturnType<typeof drizzle>;
    const queries: string[] = [];

    beforeAll(async () => {
      const target = new URL(url!);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
        throw new Error("MySQL fixtures must be local");
      const prefix = target.pathname.slice(1).replace(/_app$/, "") || "aih";
      if (!/^[a-zA-Z0-9_]+$/.test(prefix))
        throw new Error("Invalid fixture database prefix");
      databaseName = `${prefix}_links_${process.pid}_${Date.now()}`;
      connection = await mysql.createConnection({ uri: url!, timezone: "Z" });
      await connection.query(`CREATE DATABASE \`${databaseName}\``);
      await connection.query(`USE \`${databaseName}\``);
      await connection.query("SET time_zone = '+00:00'");
      await connection.query(`CREATE TABLE AI_Shortlink (
			id VARCHAR(255) PRIMARY KEY, slug VARCHAR(50), url TEXT, clicks INT,
			createdAt TIMESTAMP, updatedAt TIMESTAMP
		)`);
      await connection.query(`CREATE TABLE AI_ShortlinkClick (
			id VARCHAR(255) PRIMARY KEY, shortlinkId VARCHAR(255), timestamp TIMESTAMP
		)`);
      await connection.query(`CREATE TABLE AI_ShortlinkAttribution (
			id VARCHAR(255) PRIMARY KEY, shortlinkId VARCHAR(255), type VARCHAR(50), createdAt TIMESTAMP
		)`);
      // The cached Shortlink.clicks deliberately disagrees with the click events.
      await connection.query(`INSERT INTO AI_Shortlink VALUES
			('popular', 'popular', 'https://example.test/popular', 0, NOW(), NOW()),
			('quiet', 'quiet', 'https://example.test/quiet', 999, NOW(), NOW()),
			('old', 'old', 'https://example.test/old', 10, NOW(), NOW()),
			('empty', 'empty', 'https://example.test/empty', 1000, NOW(), NOW())`);
      await connection.query(`INSERT INTO AI_ShortlinkClick VALUES
			('p1', 'popular', NOW()), ('p2', 'popular', NOW()), ('p3', 'popular', NOW()),
			('p-old', 'popular', NOW() - INTERVAL 10 DAY),
			('q1', 'quiet', NOW()), ('old1', 'old', NOW() - INTERVAL 10 DAY),
			('old2', 'old', NOW() - INTERVAL 10 DAY)`);
      await connection.query(`INSERT INTO AI_ShortlinkAttribution VALUES
			('s1', 'popular', 'signup', NOW()), ('s2', 'popular', 'signup', NOW()),
			('p1', 'popular', 'purchase', NOW()),
			('p-old', 'popular', 'purchase', NOW() - INTERVAL 10 DAY),
			('ignored', 'popular', 'other', NOW()), ('old', 'old', 'signup', NOW() - INTERVAL 10 DAY)`);
      database = drizzle(async (query, params) => {
        queries.push(query);
        const [rows] = await connection.query(
          { sql: query, rowsAsArray: true },
          params,
        );
        return { rows: rows as unknown[][] };
      });
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

    it.each(["24h", "7d", "all"] as const)(
      "aggregates clicks and attributions for %s",
      async (range) => {
        queries.length = 0;
        const all = range === "all";
        expect(
          await getShortlinkPerformance(
            range,
            database as unknown as Parameters<
              typeof getShortlinkPerformance
            >[1],
          ),
        ).toEqual(
          [
            {
              shortlinkId: "popular",
              slug: "popular",
              url: "https://example.test/popular",
              clicks: all ? 4 : 3,
              signups: 2,
              purchases: all ? 2 : 1,
            },
            {
              shortlinkId: "quiet",
              slug: "quiet",
              url: "https://example.test/quiet",
              clicks: 1,
              signups: 0,
              purchases: 0,
            },
            ...(all
              ? [
                  {
                    shortlinkId: "old",
                    slug: "old",
                    url: "https://example.test/old",
                    clicks: 2,
                    signups: 1,
                    purchases: 0,
                  },
                ]
              : []),
          ].sort(
            (a, b) =>
              b.clicks - a.clicks || a.shortlinkId.localeCompare(b.shortlinkId),
          ),
        );
        expect(queries).toHaveLength(2);
      },
    );
  },
);
