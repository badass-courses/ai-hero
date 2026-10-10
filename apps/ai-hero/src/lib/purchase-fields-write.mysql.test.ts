import { preserveQueryResultShape } from "@/db/mysql-query-client";
import * as schema from "@/db/schema";
import { eq, is, sql, SQL } from "drizzle-orm";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql, { type Pool } from "mysql2/promise";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({
  database: undefined as unknown,
  sendAnEmail: undefined as undefined | (() => Promise<void>),
}));
vi.mock("@/db", () => ({
  get db() {
    return state.database;
  },
  courseBuilderAdapter: {},
}));
vi.mock("@coursebuilder/utils/send-an-email", () => ({
  sendAnEmail: () => state.sendAnEmail?.(),
}));
vi.mock("@/lib/purchase-benefit-telemetry", () => ({
  alertPurchaseBenefitOperator: vi.fn(),
  logPurchaseBenefitReceipt: vi.fn(),
}));
vi.mock("@/server/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/env.mjs", () => ({
  env: {
    NEXT_PUBLIC_URL: "https://example.test",
    NEXT_PUBLIC_SUPPORT_EMAIL: "support@example.test",
  },
}));
vi.mock("@/config", () => ({ default: { defaultTitle: "Fixture" } }));
vi.mock("@/emails/basic-email", () => ({ default: () => null }));
vi.mock("@/emails/welcome-cohort-email-team-redeemer", () => ({
  default: () => null,
}));
// Collaborators these writers import but never reach in these cases.
vi.mock("@/lib/entitlements", () => ({
  createCohortEntitlement: vi.fn(),
  EntitlementSourceType: {},
}));
vi.mock("@/lib/entitlements-query", () => ({
  createResourceEntitlements: vi.fn(),
}));
vi.mock("@/lib/get-workshop-availability", () => ({
  getWorkshopAvailability: vi.fn(),
}));
vi.mock("@/server/personal-organizations", () => ({
  personalOrganizations: {},
}));
vi.mock("./cohort-welcome-details-query", () => ({
  getCohortWelcomeDetails: vi.fn(),
}));

import { persistPurchaseGeoFromStripe } from "./admin-sales-globe-stripe-geo";
import { persistArchivePolicySnapshot } from "./archive-products";
import { sendBuyerPurchaseBenefitWelcomeEmail } from "./purchase-benefit-entitlements";
import { markPurchaseDisputeRefunded } from "./purchase-disputes";
import {
  purchaseFieldsJsonSet,
  updatePurchaseFields,
} from "./purchase-fields-write";

const uri = process.env.AIH_PURCHASE_FIELDS_MYSQL_URL;
const suite = uri ? describe : describe.skip;
const dialect = new MySqlDialect();
const tables = [schema.users, schema.purchases];

// Disposable DDL from the installed schema, never a production clone.
async function createFixtureSchema(pool: Pool) {
  for (const table of tables) {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => {
      const fallback =
        column.default === undefined
          ? ""
          : column.default === null
            ? " DEFAULT NULL"
            : is(column.default, SQL)
              ? ` DEFAULT ${dialect.sqlToQuery(column.default).sql}`
              : column.getSQLType() === "json"
                ? ` DEFAULT ('${JSON.stringify(column.default)}')`
                : ` DEFAULT '${String(column.default)}'`;
      return `\`${column.name}\` ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}${fallback}${column.primary ? " PRIMARY KEY" : ""}`;
    });
    if (!config.columns.some((column) => column.primary))
      for (const key of config.primaryKeys)
        columns.push(
          `PRIMARY KEY (${key.columns.map((column) => `\`${column.name}\``).join(",")})`,
        );
    await pool.query(`DROP TABLE IF EXISTS \`${config.name}\``);
    await pool.query(
      `CREATE TABLE \`${config.name}\` (${columns.join(",")}) ENGINE=InnoDB`,
    );
  }
}

const ATTRIBUTION = { source: "fixture" };
const OPEN_DISPUTE = {
  stripeDisputeId: "dp_fixture",
  state: "open",
  originalStatus: "Valid",
  revokedEntitlementIds: [],
  discordRoleIds: [],
};
const REFUNDED_AT = new Date("2026-10-20T12:00:00.000Z");

describe("purchaseFieldsJsonSet", () => {
  it("rejects keys that are not plain top-level names", () => {
    expect(() => purchaseFieldsJsonSet({ "a.b": 1 })).toThrow(/Invalid/);
    expect(() => purchaseFieldsJsonSet({ 'a"': 1 })).toThrow(/Invalid/);
  });

  it("writes nothing for an empty or all-undefined patch", () => {
    expect(purchaseFieldsJsonSet({})).toBeNull();
    expect(purchaseFieldsJsonSet({ a: undefined })).toBeNull();
  });
});

suite("Purchase.fields writers: real MySQL 8", () => {
  let pool: Pool;
  let database: MySql2Database<typeof schema>;

  beforeAll(async () => {
    const parsed = new URL(uri!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      parsed.pathname !== "/purchase_fields_test"
    )
      throw new Error(
        "Only the loopback purchase_fields_test fixture is allowed",
      );
    const server = new URL(uri!);
    server.pathname = "/";
    const bootstrap = await mysql.createConnection({ uri: server.toString() });
    await bootstrap.query("CREATE DATABASE IF NOT EXISTS purchase_fields_test");
    await bootstrap.end();
    pool = preserveQueryResultShape(
      mysql.createPool({ uri: uri!, connectionLimit: 4, timezone: "Z" }),
    );
    const getConnection = pool.getConnection.bind(pool);
    pool.getConnection = (async () =>
      preserveQueryResultShape(
        await getConnection(),
      )) as typeof pool.getConnection;
    await createFixtureSchema(pool);
    database = drizzle(pool, { schema, mode: "planetscale" });
    state.database = database;
  }, 30000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    state.database = database;
    state.sendAnEmail = undefined;
    for (const table of tables)
      await pool.query(`DELETE FROM \`${getTableConfig(table).name}\``);
    await database
      .insert(schema.users)
      .values({ id: "buyer", email: "buyer@example.test", name: "Buyer" });
  });

  const seed = (fields: Record<string, unknown>) =>
    database.insert(schema.purchases).values({
      id: "purchase",
      userId: "buyer",
      productId: "product-a",
      status: "Valid",
      totalAmount: "100",
      country: "US",
      fields,
    });

  const fields = async () => {
    const [row] = await database
      .select({ fields: schema.purchases.fields })
      .from(schema.purchases)
      .where(eq(schema.purchases.id, "purchase"));
    return row!.fields as Record<string, any>;
  };

  /** Another writer's per-key JSON_SET, as the C5 decision store does it. */
  const concurrentJsonSet = (key: string, value: unknown) =>
    database
      .update(schema.purchases)
      .set({
        fields: sql`JSON_SET(COALESCE(${schema.purchases.fields}, JSON_OBJECT()), ${`$.${key}`}, CAST(${JSON.stringify(value)} AS JSON))`,
      })
      .where(eq(schema.purchases.id, "purchase"));

  /** Runs `write` right after the next `db.query.purchases.findFirst`. */
  const afterPurchaseRead = (write: () => Promise<unknown>) => {
    let pending: (() => Promise<unknown>) | undefined = write;
    const findFirst = database.query.purchases.findFirst.bind(
      database.query.purchases,
    ) as (...args: unknown[]) => Promise<unknown>;
    const purchasesQuery = new Proxy(database.query.purchases, {
      get(target, property, receiver) {
        if (property !== "findFirst")
          return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => {
          const found = await findFirst(...args);
          const run = pending;
          pending = undefined;
          await run?.();
          return found;
        };
      },
    });
    const query = new Proxy(database.query, {
      get(target, property, receiver) {
        return property === "purchases"
          ? purchasesQuery
          : Reflect.get(target, property, receiver);
      },
    });
    state.database = new Proxy(database, {
      get(target, property, receiver) {
        return property === "query"
          ? query
          : Reflect.get(target, property, receiver);
      },
    });
  };

  const geoRow = async () => {
    const [row] = await database
      .select()
      .from(schema.purchases)
      .where(eq(schema.purchases.id, "purchase"));
    return {
      id: row!.id,
      country: row!.country,
      city: row!.city,
      state: row!.state,
      ipAddress: row!.ipAddress,
      fields: row!.fields,
      sessionIdentifier: "cs_fixture",
      chargeIdentifier: "ch_fixture",
    };
  };

  it("geo keeps a dispute refund marker written while Stripe was read", async () => {
    await seed({ attribution: ATTRIBUTION, dispute: OPEN_DISPUTE });
    const row = await geoRow();

    await persistPurchaseGeoFromStripe({
      row,
      readGeo: async () => {
        await expect(
          markPurchaseDisputeRefunded("purchase", REFUNDED_AT),
        ).resolves.toEqual({ marked: true });
        return {
          address: {
            city: "San Francisco",
            region: "CA",
            postal: "94107",
            country: "US",
          },
          metadata: { ip_address: "203.0.113.9" },
        };
      },
    });

    const after = await fields();
    expect(after.dispute).toMatchObject({
      ...OPEN_DISPUTE,
      refundedAt: REFUNDED_AT.toISOString(),
    });
    expect(after.attribution).toEqual(ATTRIBUTION);
    expect(after.globe).toMatchObject({ city: "San Francisco" });
  });

  it("geo globeAttempted fallback keeps a key written while Stripe was read", async () => {
    await seed({ attribution: ATTRIBUTION });
    const row = await geoRow();

    await persistPurchaseGeoFromStripe({
      row,
      readGeo: async () => {
        await concurrentJsonSet("dispute", OPEN_DISPUTE);
        return { address: null, metadata: {} };
      },
    });

    const after = await fields();
    expect(after.globeAttempted).toBe(true);
    expect(after.dispute).toEqual(OPEN_DISPUTE);
    expect(after.attribution).toEqual(ATTRIBUTION);
  });

  it("benefit welcome email keeps a C5 duplicate marker written during the send", async () => {
    await seed({ attribution: ATTRIBUTION });
    state.sendAnEmail = async () => {
      await concurrentJsonSet("c5DuplicateOf", "purchase-original");
    };

    await expect(
      sendBuyerPurchaseBenefitWelcomeEmail({
        purchaseId: "purchase",
        benefits: [
          {
            id: "benefit",
            type: "grant_access",
            appliesTo: "buyer",
            resourceType: "workshop",
            resourceId: "workshop-a",
          },
        ],
        applicationResults: [],
      }),
    ).resolves.toMatchObject({ status: "sent" });

    const after = await fields();
    expect(after.c5DuplicateOf).toBe("purchase-original");
    expect(after.purchaseBenefitWelcomeEmailSentAt).toEqual(expect.any(String));
    expect(after.purchaseBenefitWelcomeEmailSendingAt).toEqual(
      expect.any(String),
    );
    expect(after.attribution).toEqual(ATTRIBUTION);
  });

  it("the welcome email claim stays compare-and-set", async () => {
    await seed({ attribution: ATTRIBUTION });
    const send = vi.fn();
    state.sendAnEmail = send;
    // Another sender claims after this one read the purchase, so only the
    // SQL predicate can refuse the second claim.
    afterPurchaseRead(() =>
      concurrentJsonSet("purchaseBenefitWelcomeEmailSendingAt", "other"),
    );

    await expect(
      sendBuyerPurchaseBenefitWelcomeEmail({
        purchaseId: "purchase",
        benefits: [],
        applicationResults: [],
      }),
    ).resolves.toEqual({ status: "skipped", reason: "send-already-claimed" });

    expect(send).not.toHaveBeenCalled();
    const after = await fields();
    expect(after.purchaseBenefitWelcomeEmailSendingAt).toBe("other");
    expect(after.attribution).toEqual(ATTRIBUTION);
  });

  it("archive policy snapshot keeps attribution written after its read", async () => {
    await seed({ purchaseBenefits: [] });
    // The attribution backfill lands between the archive writer's read and
    // its write.
    afterPurchaseRead(() => concurrentJsonSet("attribution", ATTRIBUTION));

    const policy = {
      productId: "archive-product",
      availableAfterDays: 30,
    } as unknown as Parameters<
      typeof persistArchivePolicySnapshot
    >[0]["policy"];
    await persistArchivePolicySnapshot({ purchaseId: "purchase", policy });

    state.database = database;
    const after = await fields();
    expect(after.archivePolicy).toEqual(policy);
    expect(after.attribution).toEqual(ATTRIBUTION);
    expect(after.purchaseBenefits).toEqual([]);
  });

  it("writes columns and keys in one statement and leaves other keys alone", async () => {
    await seed({ attribution: ATTRIBUTION, keep: { nested: 1 } });
    await updatePurchaseFields({
      purchaseId: "purchase",
      columns: { city: "Austin" },
      patch: { globe: { lat: 1 }, cleared: null, skipped: undefined },
    });
    const after = await fields();
    expect(after).toEqual({
      attribution: ATTRIBUTION,
      keep: { nested: 1 },
      globe: { lat: 1 },
      cleared: null,
    });
    const [row] = await database
      .select({ city: schema.purchases.city })
      .from(schema.purchases)
      .where(eq(schema.purchases.id, "purchase"));
    expect(row!.city).toBe("Austin");
  });
});
