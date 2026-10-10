import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql, { type Connection } from "mysql2/promise";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { validateMySqlIntegrationServerUrl } from "@/lib/team-purchase-mysql-test-guard";
import {
  claimGiftSlot,
  bindGiftSlot,
  expireGiftSlot,
  spendGiftSlot,
  usesTaken,
  readGiftCode,
} from "./gift-slots";
import { C5_PRODUCT_ID } from "./products";

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL;
const integration = describe.skipIf(!serverUrl);
const now = new Date("2030-01-01T00:00:00Z");
const expiresAt = now.getTime() / 1000 + 3600;
const reference = "test-reference";
let admin: Connection;
let pool: mysql.Pool;
const database = `aih_gift_test_${randomUUID().replaceAll("-", "")}`;

integration("gift slots on real MySQL", () => {
  beforeAll(async () => {
    const url = validateMySqlIntegrationServerUrl(serverUrl ?? "");
    admin = await mysql.createConnection(url.href);
    await admin.query(`CREATE DATABASE \`${database}\``);
    url.pathname = `/${database}`;
    pool = mysql.createPool({
      uri: url.href,
      timezone: "Z",
      connectionLimit: 8,
    });
    await pool.query(
      `CREATE TABLE AI_Coupon (id varchar(191) PRIMARY KEY, status int, maxUses int, expires timestamp(3), restrictedToProductId varchar(191), fields json)`,
    );
    const initial = await readFile(
      new URL(
        "../../db/migrations/20261010_ai_hero_purchase_decision.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const migration = await readFile(
      new URL(
        "../../db/migrations/20261011_ai_hero_gift_codes.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const sql of [initial, migration, migration])
      for (const statement of sql.split(";").filter((part) => part.trim()))
        await pool.query(statement);
  }, 20_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE \`${database}\``);
      await admin.end();
    }
  });
  beforeEach(async () => {
    for (const table of ["AI_GiftCodeSlot", "AI_PurchaseDecision", "AI_Coupon"])
      await pool.query(`DELETE FROM ${table}`);
    await pool.query("INSERT INTO AI_Coupon VALUES (?, 1, 5, ?, ?, ?)", [
      reference,
      new Date(expiresAt * 1000),
      C5_PRODUCT_ID,
      JSON.stringify({
        purpose: "legend-gift",
        targetPriceCents: 40000,
        quantityLimit: 1,
        stackable: false,
      }),
    ]);
  });
  const withConnection = async <A>(
    run: (connection: mysql.PoolConnection) => Promise<A>,
  ) => {
    const connection = await pool.getConnection();
    try {
      return await run(connection);
    } finally {
      connection.release();
    }
  };
  const claim = (claimId: string, quantity = 1) =>
    withConnection((connection) =>
      claimGiftSlot({
        connection,
        codeRef: reference,
        productId: C5_PRODUCT_ID,
        claimId,
        quantity,
        expiresAt,
        unitPrice: 40000,
        now,
      }),
    );
  const reserve = async (id: string) => {
    const reservation = await claim(id);
    if (!reservation) throw new Error("fixture-claim-failed");
    await withConnection((connection) =>
      bindGiftSlot(connection, reservation, `cs_${id}`),
    );
    return reservation;
  };
  it("allows exactly one of five simultaneous contenders for the fifth slot, never a sixth", async () => {
    for (let i = 0; i < 4; i++) await reserve(`initial-${i}`);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => claim(`contender-${i}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claim("sixth")).toBeNull();
    expect(
      await withConnection((connection) =>
        usesTaken(connection, reference, now),
      ),
    ).toBe(5);
  });
  it("releases expired sessions, but spent uses survive late expiry, refunds, and disputes", async () => {
    await reserve("expired");
    await withConnection((connection) =>
      expireGiftSlot(connection, "cs_expired"),
    );
    expect(await claim("reuse")).not.toBeNull();
    await reserve("paid");
    expect(
      await withConnection((connection) =>
        spendGiftSlot(connection, "cs_paid", reference),
      ),
    ).toBe(true);
    await withConnection((connection) => expireGiftSlot(connection, "cs_paid"));
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT state FROM AI_GiftCodeSlot WHERE checkoutSessionId = 'cs_paid'",
    );
    expect(rows[0]?.state).toBe("spent");
    // Refund/dispute paths never call expireGiftSlot; no status filter on the ledger.
    expect(
      await withConnection((connection) =>
        spendGiftSlot(connection, "cs_paid", reference),
      ),
    ).toBe(true);
  });
  it("refuses expiry, the provider minimum lifetime, and quantity 2 or 5", async () => {
    await pool.query("UPDATE AI_Coupon SET expires = ?", [now]);
    expect(await claim("expired-code")).toBeNull();
    await pool.query("UPDATE AI_Coupon SET expires = ?", [
      new Date(now.getTime() + 10 * 60_000),
    ]);
    expect(await claim("too-short")).toBeNull();
    for (const quantity of [2, 5])
      await expect(claim(`q-${quantity}`, quantity)).rejects.toThrow(
        "gift-quantity",
      );
  });
  it("counts ledger rows and reservations without double counting a settled use", async () => {
    await reserve("paid");
    await withConnection((connection) =>
      spendGiftSlot(connection, "cs_paid", reference),
    );
    await pool.query(
      `INSERT INTO AI_PurchaseDecision (purchaseId, productId, decisionRef, codeRef, restriction, contract, engineVersion, policyVersion, checkoutSessionId, createdAt) VALUES ('purchase-test', ?, 'ref-test', ?, 'none', 'test', 'test', 'test', 'cs_paid', ?)`,
      [C5_PRODUCT_ID, reference, now],
    );
    expect(
      await withConnection((connection) =>
        usesTaken(connection, reference, now),
      ),
    ).toBe(1);
    expect(
      (
        await withConnection((connection) =>
          readGiftCode(connection, reference, C5_PRODUCT_ID, now),
        )
      )?.usesTaken,
    ).toBe(1);
  });
  it("holds ambiguous unbound claims and adopts them on paid replay", async () => {
    const reservation = await claim("ambiguous");
    expect(reservation).not.toBeNull();
    expect(
      await withConnection((connection) =>
        spendGiftSlot(connection, "cs_late", reference, "ambiguous"),
      ),
    ).toBe(true);
    await withConnection((connection) => expireGiftSlot(connection, "cs_late"));
    expect(
      await withConnection((connection) =>
        usesTaken(connection, reference, now),
      ),
    ).toBe(1);
  });
});
