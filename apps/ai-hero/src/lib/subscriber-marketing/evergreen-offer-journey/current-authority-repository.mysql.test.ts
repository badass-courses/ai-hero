import { randomUUID } from "node:crypto";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { automationControl } from "@/db/email-course-schema";
import { evergreenOfferJourneyCommit } from "@/db/evergreen-offer-journey-schema";
import { validateMySqlIntegrationServerUrl } from "../../team-purchase-mysql-test-guard";
import { createDrizzleCurrentAuthorityRepository } from "./current-authority-repository";

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL;
const integration = describe.skipIf(!serverUrl);
// Minimal isolated DDL for the selected columns, not production migrations.
const definitions = [
  [
    automationControl,
    "automationId varchar(191) primary key, control json, updatedAt timestamp(3) not null",
  ],
  [
    schema.contact,
    "id varchar(191) primary key, email varchar(191), userId varchar(191), lifecycle varchar(32)",
  ],
  [
    schema.contactState,
    "contactId varchar(191) primary key, lifecycle varchar(32)",
  ],
  [
    schema.contactLink,
    "contactId varchar(191), userId varchar(191), key(contactId)",
  ],
  [
    schema.providerIdentity,
    "contactId varchar(191), provider varchar(32), externalId varchar(191), key(contactId)",
  ],
  [
    schema.users,
    "id varchar(191) primary key, email varchar(191), unique key(email)",
  ],
  [
    schema.purchases,
    "id varchar(191) primary key, userId varchar(191), productId varchar(191), status varchar(32), createdAt timestamp(3), key(userId,status,productId)",
  ],
  [
    schema.entitlements,
    "id varchar(191) primary key, userId varchar(191), organizationId varchar(191), organizationMembershipId varchar(191), sourceType varchar(32), sourceId varchar(191), metadata json, deletedAt timestamp(3) null, expiresAt timestamp(3) null, key(userId), key(organizationId)",
  ],
  [
    schema.organizationMemberships,
    "id varchar(191) primary key, userId varchar(191), organizationId varchar(191), key(organizationId)",
  ],
  [
    schema.contentResourceProduct,
    "resourceId varchar(191), productId varchar(191), key(productId)",
  ],
  [
    schema.contactEvent,
    "id varchar(191) primary key, contactId varchar(191), eventType varchar(191), semanticIdempotencyKey varchar(255), payloadSummary json, unique key(semanticIdempotencyKey)",
  ],
  [
    evergreenOfferJourneyCommit,
    "journeyId varchar(191), actorVersion int, snapshot json, primary key(journeyId,actorVersion)",
  ],
] as const;
const table = (value: Parameters<typeof getTableName>[0]) =>
  `\`${getTableName(value)}\``;

integration("current authority isolated MySQL reads", () => {
  let server: Pool | undefined;
  let pool: Pool | undefined;
  let databaseName: string | undefined;
  let repository: ReturnType<typeof createDrizzleCurrentAuthorityRepository>;
  beforeAll(async () => {
    const safe = validateMySqlIntegrationServerUrl(serverUrl!, {
      nodeEnv: process.env.NODE_ENV,
      vercelEnv: process.env.VERCEL_ENV,
    });
    server = mysql.createPool({
      uri: safe.toString(),
      connectionLimit: 1,
      timezone: "Z",
    });
    databaseName = `aih_authority_test_${randomUUID().replaceAll("-", "")}`;
    await server.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    );
    const url = new URL(safe);
    url.pathname = `/${databaseName}`;
    pool = mysql.createPool({
      uri: url.toString(),
      connectionLimit: 1,
      timezone: "Z",
    });
    for (const [name, columns] of definitions)
      await pool.query(`CREATE TABLE ${table(name)} (${columns})`);
    repository = createDrizzleCurrentAuthorityRepository(
      drizzle({ client: pool, schema, mode: "default" }),
    );
  });
  beforeEach(async () => {
    for (const [name] of definitions)
      await pool!.query(`DELETE FROM ${table(name)}`);
  });
  afterAll(async () => {
    await pool?.end();
    if (server && databaseName)
      await server.query(`DROP DATABASE \`${databaseName}\``);
    await server?.end();
  });
  it("reads exact control keys and observes a changed version", async () => {
    expect(await repository.readControl("current")).toBeNull();
    await pool!.query(
      `INSERT INTO ${table(automationControl)} VALUES (?, ?, ?)`,
      [
        "current",
        JSON.stringify({ type: "Enabled", version: "v1" }),
        "2026-09-07 19:00:00.000",
      ],
    );
    expect((await repository.readControl("current"))?.control).toMatchObject({
      version: "v1",
    });
    expect(await repository.readControl("other")).toBeNull();
    await pool!.query(
      `UPDATE ${table(automationControl)} SET control = ? WHERE automationId = ?`,
      [JSON.stringify({ type: "Stopped", version: "v2" }), "current"],
    );
    expect((await repository.readControl("current"))?.control).toMatchObject({
      version: "v2",
    });
  });
  it("reads bounded contact/provider/user evidence, including conflicting linked users", async () => {
    await pool!.query(
      `INSERT INTO ${table(schema.contact)} VALUES ('contact', 'student@example.com', 'user', 'new')`,
    );
    await pool!.query(
      `INSERT INTO ${table(schema.contactState)} VALUES ('contact', 'new')`,
    );
    await pool!.query(
      `INSERT INTO ${table(schema.providerIdentity)} VALUES ('contact', 'kit', '123')`,
    );
    await pool!.query(
      `INSERT INTO ${table(schema.users)} VALUES ('user', 'student@example.com'), ('other', 'other@example.com')`,
    );
    await pool!.query(
      `INSERT INTO ${table(schema.contactLink)} VALUES ('contact', 'other')`,
    );
    const rows = await repository.readIdentity("contact");
    expect(rows.users).toHaveLength(2);
    expect(rows.providers).toEqual([
      { contactId: "contact", provider: "kit", externalId: "123" },
    ]);
  });
  it("excludes non-target and refunded purchases, then observes Restricted target ownership", async () => {
    await pool!.query(
      `INSERT INTO ${table(schema.contentResourceProduct)} VALUES ('course', 'product-ma254')`,
    );
    await pool!.query(
      `INSERT INTO ${table(schema.purchases)} VALUES ('other', 'user', 'other-product', 'Valid', NOW(3)), ('target', 'user', 'product-ma254', 'Refunded', NOW(3))`,
    );
    expect(await repository.readPurchases("user", new Date())).toEqual([]);
    await pool!.query(
      `UPDATE ${table(schema.purchases)} SET status = 'Restricted' WHERE id = 'target'`,
    );
    expect(await repository.readPurchases("user", new Date())).toMatchObject([
      { id: "target", via: "direct", effectiveProductId: "product-ma254" },
    ]);
  });
  it.each([null, "different-org", "org"])(
    "reads team ownership by membership alone for org %s, excluding deleted/expired access",
    async (organizationId) => {
      await pool!.query(
        `INSERT INTO ${table(schema.purchases)} VALUES ('purchase', 'buyer', 'source-bundle', 'Valid', NOW(3))`,
      );
      await pool!.query(
        `INSERT INTO ${table(schema.organizationMemberships)} VALUES ('member', 'recipient', 'org')`,
      );
      await pool!.query(
        `INSERT INTO ${table(schema.contentResourceProduct)} VALUES ('course', 'product-ma254')`,
      );
      await pool!.query(
        `INSERT INTO ${table(schema.entitlements)} VALUES ('access', null, ?, 'member', 'PURCHASE', 'purchase', ?, null, null)`,
        [organizationId, JSON.stringify({ contentIds: ["course"] })],
      );
      expect(
        await repository.readPurchases("recipient", new Date()),
      ).toMatchObject([
        {
          id: "purchase",
          productId: "source-bundle",
          beneficiaryUserId: "recipient",
          via: "entitlement",
        },
      ]);
      await pool!.query(
        `UPDATE ${table(schema.entitlements)} SET expiresAt = '2026-01-01 00:00:00.000'`,
      );
      expect(
        await repository.readPurchases("recipient", new Date("2026-09-07")),
      ).toEqual([]);
      await pool!.query(
        `UPDATE ${table(schema.entitlements)} SET expiresAt = null, deletedAt = NOW(3)`,
      );
      expect(await repository.readPurchases("recipient", new Date())).toEqual(
        [],
      );
    },
  );
  it("holds absent target resource mapping rather than returning no purchase", async () => {
    await expect(
      repository.readPurchases("recipient", new Date()),
    ).rejects.toThrow("resource mapping");
  });
  it.each(["missing-purchase", "missing-resource"])(
    "keeps %s source evidence visible instead of returning no ownership",
    async (scenario) => {
      await pool!.query(
        `INSERT INTO ${table(schema.organizationMemberships)} VALUES ('member','recipient','org')`,
      );
      await pool!.query(
        `INSERT INTO ${table(schema.contentResourceProduct)} VALUES ('course','product-ma254')`,
      );
      if (scenario === "missing-resource")
        await pool!.query(
          `INSERT INTO ${table(schema.purchases)} VALUES ('purchase','buyer','product-ma254','Valid',NOW(3))`,
        );
      await pool!.query(
        `INSERT INTO ${table(schema.entitlements)} VALUES ('access',null,null,'member','PURCHASE','purchase',?,null,null)`,
        [
          JSON.stringify({
            contentIds: [
              scenario === "missing-resource" ? "unmapped-course" : "course",
            ],
          }),
        ],
      );
      const rows = await repository.readPurchases("recipient", new Date());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject(
        scenario === "missing-resource"
          ? { id: "purchase", effectiveProductId: null }
          : { id: null, effectiveProductId: "product-ma254" },
      );
    },
  );
  it("returns both canonical facts and only the latest head for each indexed ID", async () => {
    await pool!.query(
      `INSERT INTO ${table(schema.contactEvent)} VALUES ('one', 'contact', 'course.sequence-exhausted', 'key-one', '{}'), ('two', 'contact', 'course.sequence-exhausted', 'key-two', '{}'), ('other', 'contact', 'other', 'other', '{}')`,
    );
    expect(
      await repository.readExhaustionFacts(["key-one", "key-two"]),
    ).toHaveLength(2);
    await pool!.query(
      `INSERT INTO ${table(evergreenOfferJourneyCommit)} VALUES ('journey-one', 1, '{}'), ('journey-one', 2, '{}'), ('journey-two', 1, '{}')`,
    );
    expect(
      await repository.readJourneyHeads(["journey-one", "journey-two"]),
    ).toEqual([
      { journeyId: "journey-one", actorVersion: 2, snapshot: {} },
      { journeyId: "journey-two", actorVersion: 1, snapshot: {} },
    ]);
  });
});
