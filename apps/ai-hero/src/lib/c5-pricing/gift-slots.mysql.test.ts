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
  recoverUnboundGiftSlot,
} from "./gift-slots";
import { C5_PRODUCT_ID } from "./products";
import { encodeDecisionRef } from "./decision";
import { createGiftCheckout } from "./gift-checkout";
import { recoverDueGiftReservations } from "./gift-reservation-recovery";

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
    await pool.query(await readFile(new URL('../../db/migrations/20261012_ai_hero_gift_claim_evidence.sql', import.meta.url), 'utf8'));
    await pool.query('CREATE TABLE AI_Purchase (id varchar(191) PRIMARY KEY, fields json)');
  }, 20_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE \`${database}\``);
      await admin.end();
    }
  });
  beforeEach(async () => {
    for (const table of ["AI_GiftCodeSlot", "AI_PurchaseDecision", "AI_Purchase", "AI_Coupon"])
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
  it("counts overdue reserved rows identically in facts and claims", async () => {
    for (let i = 0; i < 5; i++) await claim(`past-${i}`);
    await pool.query('UPDATE AI_GiftCodeSlot SET expiresAt = ?', [new Date(now.getTime() - 1)]);
    expect((await withConnection(c => readGiftCode(c, reference, C5_PRODUCT_ID, now)))?.usesTaken).toBe(5);
    expect(await claim('sixth')).toBeNull();
  });
  it("provider failure after claim releases after two-hour grace and sweep allows reclaim", async () => {
    await pool.query('UPDATE AI_Coupon SET expires = ?', [new Date(now.getTime() + 24 * 3600000)]);
    for (let i = 0; i < 4; i++) {
      await reserve(`paid-${i}`);
      await withConnection(c => spendGiftSlot(c, `cs_paid-${i}`, reference));
    }
    await expect(createGiftCheckout({
      params: { mode: 'payment', expires_at: expiresAt, line_items: [{ quantity: 1 }], metadata: { productId: C5_PRODUCT_ID, bulk: 'false', expectedTotalCents: '40000', decisionRef: encodeDecisionRef('0000000000000000', null, reference) } },
      create: async () => { throw new Error('synthetic-provider-failure'); },
      deps: {
        fact: async () => ({ value: await withConnection(c => readGiftCode(c, reference, C5_PRODUCT_ID, now)), sourceRefs: ['synthetic'] }),
        claim: input => withConnection(c => claimGiftSlot({ ...input, connection: c, productId: C5_PRODUCT_ID, now })),
        bind: (claim, id) => withConnection(c => bindGiftSlot(c, claim, id)),
        flag: async () => undefined,
      },
    })).rejects.toThrow('synthetic-provider-failure');
    expect((await withConnection(c => readGiftCode(c, reference, C5_PRODUCT_ID, now)))?.usesTaken).toBe(5);
    const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT claimId FROM AI_GiftCodeSlot WHERE state = 'reserved'");
    const after = new Date(expiresAt * 1000 + 2 * 3600000);
    expect(await withConnection(c => recoverUnboundGiftSlot(c, row!.claimId, reference, new Date(after.getTime() - 1)))).toBe('held');
    const result = await recoverDueGiftReservations({
      listDue: async () => [{ codeRef: reference, claimId: row!.claimId, checkoutSessionId: null }],
      recoverUnbound: r => withConnection(c => recoverUnboundGiftSlot(c, r.claimId, r.codeRef, after)),
      retrieve: async () => { throw new Error('unbound must not retrieve'); },
      settle: async () => { throw new Error('unbound must not settle'); },
      flag: async () => undefined,
    });
    expect(result).toMatchObject({ unboundReleased: 1, held: 0 });
    expect((await withConnection(c => readGiftCode(c, reference, C5_PRODUCT_ID, after)))?.usesTaken).toBe(4);
    expect(await withConnection(c => claimGiftSlot({ connection: c, codeRef: reference, productId: C5_PRODUCT_ID, claimId: 'reclaimed-after-provider-failure', quantity: 1, expiresAt: after.getTime() / 1000 + 3600, unitPrice: 40000, now: after }))).not.toBeNull();
  });
  it("unbound cleanup spends purchase or ledger evidence instead of releasing", async () => {
    await claim('purchase-evidence');
    await pool.query("UPDATE AI_GiftCodeSlot SET expiresAt = ?", [new Date(now.getTime() - 2 * 3600000)]);
    await pool.query('INSERT INTO AI_Purchase VALUES (?, ?)', ['synthetic-purchase', JSON.stringify({ giftClaimId: 'purchase-evidence' })]);
    expect(await withConnection(c => recoverUnboundGiftSlot(c, 'purchase-evidence', reference, now))).toBe('spent');
    await claim('ledger-evidence');
    await pool.query("UPDATE AI_GiftCodeSlot SET expiresAt = ? WHERE claimId = 'ledger-evidence'", [new Date(now.getTime() - 2 * 3600000)]);
    await pool.query("INSERT INTO AI_PurchaseDecision (purchaseId, productId, decisionRef, codeRef, giftClaimId, giftSlot, restriction, contract, engineVersion, policyVersion, checkoutSessionId, createdAt) VALUES ('synthetic-ledger', ?, 'synthetic', ?, 'ledger-evidence', 2, 'none', 'test', 'test', 'test', 'cs_evidence', ?)", [C5_PRODUCT_ID, reference, now]);
    expect(await withConnection(c => recoverUnboundGiftSlot(c, 'ledger-evidence', reference, now))).toBe('spent');
    expect(await withConnection(c => usesTaken(c, reference, now))).toBe(2);
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
