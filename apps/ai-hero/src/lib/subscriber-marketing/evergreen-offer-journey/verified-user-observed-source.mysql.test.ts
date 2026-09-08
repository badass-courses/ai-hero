import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import mysql, { type Pool } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import * as schema from "@/db/schema";
import * as journeySchema from "@/db/evergreen-offer-journey-schema";
import { preserveQueryResultShape } from "@/db/mysql-query-client";
import { validateMySqlIntegrationServerUrl } from "../../team-purchase-mysql-test-guard";
import { contactEmailWriteValues } from "../contact-email-equivalence";
import { createDrizzleJourneyLedger } from "./drizzle-ledger";
import { ownerProofFixture } from "./verified-owner-proof.fixtures";
import { createCouponAuthority } from "./coupon-authority";
import {
  createMySqlCouponCommerceStore,
  couponCommerceSchema,
} from "./coupon-authority-mysql";
import { commerceDdl } from "./coupon-executor-commerce.fixtures";
import {
  createOwnedEmailObservationTransactions,
  createMySqlEmailObservationLeaseSource,
} from "./email-observation-transaction";
import {
  createVerifiedUserObservedSource,
  createVerifiedUserObservedReader,
} from "./verified-user-observed-source";
import { createEvergreenOfferJourneyService } from "./service";
import { parseIsoInstant } from "./primitives";

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL;
const suite = describe.skipIf(!serverUrl);
suite("secure claim source disposable MySQL", () => {
  let server: Pool, pool: Pool, second: Pool, name: string;
  let database: ReturnType<typeof databaseFor>;
  let f: ReturnType<typeof ownerProofFixture>;
  let api: ReturnType<typeof createVerifiedUserObservedSource>;
  let now: Date;
  let fault = false,
    stopped = false,
    purchased = false,
    advances = 0;
  const databaseFor = (p: Pool) =>
    drizzle(preserveQueryResultShape(p), {
      schema: { ...schema, ...journeySchema },
      mode: "planetscale",
    });
  beforeAll(async () => {
    const safe = validateMySqlIntegrationServerUrl(serverUrl!, {
      nodeEnv: process.env.NODE_ENV,
      vercelEnv: process.env.VERCEL_ENV,
    });
    server = mysql.createPool({ uri: safe.toString(), timezone: "Z" });
    name = `aih_claim_test_${randomUUID().replaceAll("-", "")}`;
    await server.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    );
    const uri = new URL(safe);
    uri.pathname = `/${name}`;
    pool = mysql.createPool({
      uri: uri.toString(),
      timezone: "Z",
      multipleStatements: true,
      connectionLimit: 8,
    });
    second = mysql.createPool({
      uri: uri.toString(),
      timezone: "Z",
      connectionLimit: 3,
    });
    for (const migration of [
      "20260504_ai_hero_subscriber_marketing_gate_a.sql",
      "20260714_ai_hero_optin_attribution.sql",
      "20260717_ai_hero_side_effect_intent_completed_at.sql",
      "plans/20260908_contact_email_equivalence.sql",
      "20260831_ai_hero_email_course_evergreen_schema.sql",
      "20260907_evergreen_admission_attempts.sql",
    ])
      await pool.query(
        await fs.readFile(
          new URL(`../../../db/migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    for (const ddl of commerceDdl.slice(1)) await pool.query(ddl);
    await pool.query(
      "CREATE TABLE AI_Session (sessionToken varchar(255) PRIMARY KEY,userId varchar(255) NOT NULL,expires timestamp NOT NULL)",
    );
    database = databaseFor(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await second?.end();
    if (server && name) await server.query(`DROP DATABASE \`${name}\``);
    await server?.end();
  });
  beforeEach(async () => {
    for (const t of [
      "AI_Entitlement",
      "AI_Coupon",
      "AI_MerchantCoupon",
      "AI_EntitlementType",
      "AI_Session",
      "AI_User",
      "AI_ContactEvent",
      "AI_ProviderIdentity",
      "AI_Contact",
      "AI_EvergreenOfferJourneyAttempt",
      "AI_EvergreenOfferJourneyIntent",
      "AI_EvergreenOfferJourneyWake",
      "AI_EvergreenOfferJourneyCommit",
    ])
      await pool.query(`DELETE FROM \`${t}\``);
    f = ownerProofFixture();
    now = new Date(f.now);
    fault = false;
    stopped = false;
    purchased = false;
    advances = 0;
    await database
      .insert(schema.contact)
      .values({
        id: f.identity.contactId,
        ...contactEmailWriteValues("proof@example.test"),
      });
    await database.insert(schema.providerIdentity).values(f.identity);
    const { createdAt, ...login } = f.rows[0]!;
    await database.insert(schema.contactEvent).values(login);
    await database
      .insert(schema.users)
      .values({
        id: f.login.userId,
        email: "proof@example.test",
        emailVerified: new Date(f.login.verifiedAt),
      });
    await database
      .insert(schema.sessions)
      .values({
        sessionToken: "synthetic-session",
        userId: f.login.userId,
        expires: new Date(now.getTime() + 3600000),
      });
    const ledger = createDrizzleJourneyLedger(database);
    for (const candidate of f.candidates.slice(0, 3))
      await Effect.runPromise(ledger.commit(candidate));
    const merchant = {
      id: "claim-merchant",
      identifier: "synthetic",
      merchantAccountId: "synthetic",
      currency: "USD",
      amountOffCents: f.issueIntent.terms.amountOffCents,
      type: "special",
      sourceReference: "synthetic-not-provider-proof",
    };
    await database
      .insert(schema.merchantCoupon)
      .values({
        id: merchant.id,
        identifier: merchant.identifier,
        merchantAccountId: merchant.merchantAccountId,
        amountDiscount: merchant.amountOffCents,
        status: 1,
        type: "special",
      });
    const commerce = drizzle(preserveQueryResultShape(pool), {
      schema: couponCommerceSchema,
      mode: "planetscale",
    });
    const authority = createCouponAuthority({
      store: createMySqlCouponCommerceStore(commerce),
      merchantCouponEvidence: merchant,
      now: () => f.issueIntent.issueAt,
      readVerifiedOwner: async () => null,
    });
    await Effect.runPromise(authority.issue(f.issueIntent));
    const facts = f.candidates[2]!.currentFacts;
    const offerAuthority = {
      currentFacts: () =>
        Effect.succeed({
          ...facts,
          existingJourneyId: f.issueIntent.journeyId,
          purchase: purchased ? { type: "Purchased" as const } : facts.purchase,
          automationControl: stopped
            ? { type: "Stopped" as const, version: "stop", reason: "test" }
            : { type: "Enabled" as const, version: "test" },
        }),
    };
    // Purchase mutations are exercised through the valid original authority shape below.
    const currentFacts = {
      currentFacts: () =>
        purchased
          ? Effect.fail({
              type: "AuthorityUnavailable" as const,
              reason: "purchase-refusal-fixture",
            })
          : offerAuthority
              .currentFacts()
              .pipe(
                Effect.map(({ purchase: _, ...rest }) => ({
                  ...rest,
                  purchase: null,
                })),
              ),
    };
    const service = createEvergreenOfferJourneyService({
      ledger,
      authority: currentFacts,
      clock: {
        now: Effect.sync(() => {
          const parsed = parseIsoInstant(now.toISOString());
          if (!parsed.ok) throw new Error("Invalid test clock");
          return parsed.value;
        }),
      },
      definition: f.candidates[0]!.definition,
    });
    api = createVerifiedUserObservedSource({
      transactions: createOwnedEmailObservationTransactions(
        createMySqlEmailObservationLeaseSource({ pool }),
      ),
      readback: databaseFor(second),
      ledger,
      authority: currentFacts,
      service: {
        advance: (input) =>
          Effect.suspend(() => {
            advances++;
            return fault
              ? Effect.fail({
                  type: "JourneyCommitUnavailable" as const,
                  reason: "crash",
                })
              : service.advance(input);
          }),
      },
      secret: f.secret,
      now: () => now,
    });
  });
  const session = () => ({
    userId: f.login.userId,
    sessionToken: "synthetic-session",
  });
  const claims = () =>
    database
      .select()
      .from(schema.contactEvent)
      .where(
        eq(schema.contactEvent.eventType, "evergreen.offer_claim_observed.v1"),
      );
  it("status writes no claim; POST source commits before advance and keeps immutable replay", async () => {
    expect(await api.status(session())).toBe("ready");
    expect(await claims()).toHaveLength(0);
    expect(await api.claim(session())).toBe("pending");
    const first = await claims();
    expect(first).toHaveLength(1);
    expect(advances).toBe(1);
    expect(
      await database
        .select()
        .from(journeySchema.evergreenOfferJourneyIntent)
        .where(
          eq(
            journeySchema.evergreenOfferJourneyIntent.intentType,
            "BindCoupon",
          ),
        ),
    ).toHaveLength(1);
    now = new Date(now.getTime() + 1000);
    expect(await api.claim(session())).toBe("pending");
    expect(await claims()).toEqual(first);
  });
  it("commit before advance failure remains recoverable through fresh bounded reader", async () => {
    fault = true;
    expect(await api.claim(session())).toBe("pending");
    const page = await createVerifiedUserObservedReader(
      databaseFor(second),
    ).page({ limit: 10 });
    expect(page.candidates).toHaveLength(1);
    expect(page.held).toEqual([]);
    expect(page.candidates[0]!.sourceReference).toBe(
      `contact-event:${(await claims())[0]!.id}`,
    );
  });
  it.each([
    "forged-user",
    "forged-session",
    "missing-login",
    "revision",
    "expired",
    "duplicate",
    "stale",
    "stopped",
    "coupon-used",
  ])("holds %s without source or advance", async (mode) => {
    let s = session();
    if (mode === "forged-user") s = { ...s, userId: "victim" };
    if (mode === "forged-session") s = { ...s, sessionToken: "forged" };
    if (mode === "missing-login") await database.delete(schema.contactEvent);
    if (mode === "revision")
      await database.update(schema.users).set({ emailVerified: new Date(now) });
    if (mode === "expired")
      await database
        .update(schema.sessions)
        .set({ expires: new Date(now.getTime() - 1000) });
    if (mode === "duplicate")
      await database
        .insert(schema.contact)
        .values({
          id: "duplicate",
          ...contactEmailWriteValues(" PROOF@example.test "),
        });
    if (mode === "stale")
      await database
        .insert(schema.contact)
        .values({ id: "old-writer", email: "proof@example.test" });
    if (mode === "stopped") stopped = true;
    if (mode === "coupon-used")
      await database.update(schema.coupon).set({ usedCount: 1 });
    expect(await api.claim(s)).toBe("unavailable");
    expect(await claims()).toHaveLength(0);
    expect(advances).toBe(0);
  });
  it("concurrent claims preserve one source", async () => {
    const results = await Promise.all([
      api.claim(session()),
      api.claim(session()),
    ]);
    expect(results).toContain("pending");
    expect(await claims()).toHaveLength(1);
  });
});
