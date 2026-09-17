import { randomUUID, createHash } from "node:crypto";
import { Auth } from "@auth/core";
import Postmark from "@auth/core/providers/postmark";
import { DrizzleAdapter } from "@coursebuilder/adapter-drizzle";
import { mysqlTable } from "@/db/mysql-table";
import type { MySqlDatabase } from "drizzle-orm/mysql-core";
import { createEvergreenClaimHttp } from "@/server/evergreen-claim-http";
import {
  createVerifiedEmailObservation,
  type EmailLoginCapture,
} from "@/server/verified-email-observation";
import {
  createOAuthContainmentAdapter,
  runWithOAuthContainmentRequest,
} from "@/server/oauth-link-containment";
import { createEmailTokenLoginObservationWriter } from "./email-token-login-observation-mysql";
import fs from "node:fs/promises";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
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
import { createBridgeRuntime } from "./bridge-runtime";
import { createBoundedJourneyReaders } from "./bounded-readers";
import { createDrizzleJourneyAttempts } from "./drizzle-attempts";
import { createCouponIntentExecutor } from "./coupon-executor";
import { createCouponReceiptReader } from "./coupon-receipt-reader";
import { createMySqlCouponReceiptReadStore } from "./coupon-authority-mysql";
import {
  createVerifiedOwnerProofReader,
  createMySqlVerifiedOwnerEvidenceReadStore,
} from "./verified-owner-proof";
import { createRevisionDelivery } from "./revision-delivery";
import {
  emailTokenHash,
  loginSemanticKey,
  claimSemanticKey,
} from "./verified-owner-evidence";
import type { OfferAuthority } from "./ports";

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL;
const suite = describe.skipIf(!serverUrl);
suite("secure claim source disposable MySQL", () => {
  let server: Pool, pool: Pool, second: Pool, name: string;
  let database: ReturnType<typeof databaseFor>;
  let f: ReturnType<typeof ownerProofFixture>;
  let api: ReturnType<typeof createVerifiedUserObservedSource>;
  let now: Date;
  let currentAuthority: OfferAuthority;
  let beforeCommit: (() => Promise<void>) | undefined;
  let commitFault: "none" | "before" | "after" = "none";
  let fault = false,
    stopped = false,
    purchased = false,
    advances = 0;
  const fixtureNow = () => {
    const parsed = parseIsoInstant(now.toISOString());
    if (!parsed.ok) throw new Error("Invalid fixture clock");
    return parsed.value;
  };
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
    await pool.query(
      "CREATE TABLE AI_VerificationToken (identifier varchar(255) NOT NULL,token varchar(255) NOT NULL,expires timestamp NOT NULL,createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3),PRIMARY KEY(identifier,token))",
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
      "AI_VerificationToken",
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
    beforeCommit = undefined;
    commitFault = "none";
    f = ownerProofFixture();
    now = new Date(f.now);
    fault = false;
    stopped = false;
    purchased = false;
    advances = 0;
    await database.insert(schema.contact).values({
      id: f.identity.contactId,
      ...contactEmailWriteValues("proof@example.test"),
    });
    await database.insert(schema.providerIdentity).values(f.identity);
    const { createdAt, ...login } = f.rows[0]!;
    await database.insert(schema.contactEvent).values(login);
    await database.insert(schema.users).values({
      id: f.login.userId,
      email: "proof@example.test",
      emailVerified: new Date(f.login.verifiedAt),
    });
    await database.insert(schema.sessions).values({
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
    await database.insert(schema.merchantCoupon).values({
      id: merchant.id,
      identifier: merchant.identifier,
      merchantAccountId: merchant.merchantAccountId,
      amountDiscount: merchant.amountOffCents,
      status: 1,
      type: "special",
    });
    await database
      .insert(schema.entitlementTypes)
      .values({ id: "claim-credit-type", name: "apply_special_credit" });
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
    const currentFacts = {
      currentFacts: () =>
        Effect.succeed({
          ...facts,
          // This is a new authority read, not the historical issuance observation.
          readAt: fixtureNow(),
          existingJourneyId: f.issueIntent.journeyId,
          purchase: purchased
            ? {
                purchaseId: "synthetic-purchase",
                offerProductFamily: "ai-coding-crash-course" as const,
                sourceProductId: "synthetic",
                purchasedAt: f.issueIntent.issueAt,
                sourceReference: "fixture:not-provider-proof",
              }
            : null,
          automationControl: stopped
            ? { type: "Stopped" as const, version: "stop", reason: "test" }
            : { type: "Enabled" as const, version: "test" },
        }),
    };
    currentAuthority = currentFacts;
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
      transactions: createOwnedEmailObservationTransactions({
        async acquire() {
          const lease = await createMySqlEmailObservationLeaseSource({
            pool,
          }).acquire();
          return {
            ...lease,
            async commit() {
              if (beforeCommit) await beforeCommit();
              if (commitFault === "before")
                throw new Error("commit unavailable");
              await lease.commit();
              if (commitFault === "after")
                throw new Error("commit acknowledgement lost");
            },
          };
        },
      }),
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
  function reconstructedRuntime() {
    const db = databaseFor(second);
    const ledger = createDrizzleJourneyLedger(db);
    const attempts = createDrizzleJourneyAttempts(db);
    const clock = {
      now: Effect.sync(() => {
        const value = parseIsoInstant(now.toISOString());
        if (!value.ok) throw new Error("Invalid fixture clock");
        return value.value;
      }),
    };
    const service = createEvergreenOfferJourneyService({
      ledger,
      authority: currentAuthority,
      clock,
      definition: f.candidates[0]!.definition,
    });
    const commerce = drizzle(preserveQueryResultShape(second), {
      schema: couponCommerceSchema,
      mode: "planetscale",
    });
    const proof = createVerifiedOwnerProofReader({
      store: createMySqlVerifiedOwnerEvidenceReadStore(db),
      secret: f.secret,
      now: () => now.toISOString(),
    });
    const coupons = createCouponIntentExecutor({
      ledger,
      attempts,
      authority: currentAuthority,
      service,
      clock,
      coupons: createCouponAuthority({
        store: createMySqlCouponCommerceStore(commerce),
        merchantCouponEvidence: {
          id: "claim-merchant",
          identifier: "synthetic",
          merchantAccountId: "synthetic",
          currency: "USD",
          amountOffCents: f.issueIntent.terms.amountOffCents,
          type: "special",
          sourceReference: "synthetic-not-provider-proof",
        },
        readVerifiedOwner: proof,
        now: () => now.toISOString(),
      }),
      receipts: createCouponReceiptReader(
        createMySqlCouponReceiptReadStore(commerce),
      ),
    });
    const messages = createRevisionDelivery({
      bundles: [],
      dependencies: {
        ledger,
        attempts,
        authority: currentAuthority,
        service,
        clock,
      },
      now: () => now.toISOString(),
      kit: {
        apiKey: "no-provider",
        resolveIdentity: async () => {
          throw new Error("No provider identity resolution permitted");
        },
        fetch: async () => {
          throw new Error("No provider call permitted");
        },
      },
    });
    return createBridgeRuntime({
      clock,
      service,
      readers: createBoundedJourneyReaders(db, ledger),
      messages,
      coupons,
      claimSource: createVerifiedUserObservedReader(db),
      control: () =>
        Effect.succeed(
          stopped
            ? { type: "Disabled" as const }
            : { type: "Enabled" as const, generation: "claim-proof" },
        ),
    });
  }
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
    "purchased",
    "coupon-revoked",
    "coupon-expired",
    "forwarded-generic-url",
    "reused-old-login-evidence",
    "email-changed",
    "oauth-no-attestation",
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
      await database.insert(schema.contact).values({
        id: "duplicate",
        ...contactEmailWriteValues(" PROOF@example.test "),
      });
    if (mode === "stale")
      await database
        .insert(schema.contact)
        .values({ id: "old-writer", email: "proof@example.test" });
    if (mode === "stopped") stopped = true;
    if (mode === "coupon-expired") {
      now = new Date(f.issueIntent.expiresAt);
      await database
        .update(schema.sessions)
        .set({ expires: new Date(now.getTime() + 3600000) });
    }
    if (mode === "forwarded-generic-url") {
      await database.insert(schema.users).values({
        id: "other-user",
        email: "other@example.test",
        emailVerified: new Date(now),
      });
      await database.insert(schema.sessions).values({
        sessionToken: "other-session",
        userId: "other-user",
        expires: new Date(now.getTime() + 3600000),
      });
      s = { userId: "other-user", sessionToken: "other-session" };
    }
    if (mode === "reused-old-login-evidence") {
      await database.insert(schema.sessions).values({
        sessionToken: "new-session-with-no-attestation",
        userId: f.login.userId,
        expires: new Date(now.getTime() + 3600000),
      });
      s = { ...s, sessionToken: "new-session-with-no-attestation" };
    }
    if (mode === "purchased") purchased = true;
    if (mode === "coupon-revoked")
      await database.update(schema.coupon).set({ status: 0 });
    if (mode === "email-changed")
      await database
        .update(schema.users)
        .set({ email: "other@example.test", emailVerified: null });
    if (mode === "oauth-no-attestation") {
      await database.delete(schema.contactEvent);
      await database.update(schema.users).set({ emailVerified: new Date(now) });
    }
    if (mode === "coupon-used")
      await database.update(schema.coupon).set({ usedCount: 1 });
    expect(await api.claim(s)).toBe("unavailable");
    expect(await claims()).toHaveLength(0);
    expect(advances).toBe(0);
  });
  it("bounded reader holds corrupted source and deleted login without replaying it", async () => {
    fault = true;
    await api.claim(session());
    const saved = (await claims())[0]!;
    await database
      .update(schema.contactEvent)
      .set({
        payloadSummary: { ...saved.payloadSummary, unexpected: "forged" },
      })
      .where(eq(schema.contactEvent.id, saved.id));
    let page = await createVerifiedUserObservedReader(database).page({
      limit: 1,
    });
    expect(page.candidates).toHaveLength(0);
    expect(page.held).toHaveLength(1);
    await database
      .update(schema.contactEvent)
      .set({ payloadSummary: saved.payloadSummary })
      .where(eq(schema.contactEvent.id, saved.id));
    await database
      .delete(schema.contactEvent)
      .where(eq(schema.contactEvent.id, f.rows[0]!.id));
    page = await createVerifiedUserObservedReader(database).page({ limit: 1 });
    expect(page.candidates).toHaveLength(0);
    expect(page.held).toHaveLength(1);
    expect(
      (
        await createVerifiedUserObservedReader(database).page({
          limit: 1,
          after: page.cursor!,
        })
      ).candidates,
    ).toHaveLength(0);
  });
  it.each(["before", "after"] as const)(
    "independent committed readback resolves %s-COMMIT transport failure",
    async (mode) => {
      commitFault = mode;
      expect(await api.claim(session())).toBe(
        mode === "after" ? "pending" : "unavailable",
      );
      expect(await claims()).toHaveLength(mode === "after" ? 1 : 0);
      expect(advances).toBe(mode === "after" ? 1 : 0);
    },
  );
  async function actualLoginAndClaim(
    rawToken = "synthetic-token",
    resetEvidence = true,
    expectedStatus: "ready" | "pending" = "ready",
  ) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      if (resetEvidence) {
        await database.delete(schema.contactEvent);
        await database.delete(schema.sessions);
      }
      const adapter = DrizzleAdapter<MySqlDatabase<any, any, any>>(
        database,
        mysqlTable,
      );
      const authSecret = "synthetic-auth-secret",
        address = "proof@example.test";
      await adapter.createVerificationToken!({
        identifier: address,
        token: createHash("sha256")
          .update(rawToken + authSecret)
          .digest("hex"),
        expires: new Date(now.getTime() + 60000),
      });
      const captures: EmailLoginCapture[] = [],
        outcomes: string[] = [];
      const writer = createEmailTokenLoginObservationWriter({
        database,
        transactions: createOwnedEmailObservationTransactions(
          createMySqlEmailObservationLeaseSource({ pool }),
        ),
        readbackDatabase: databaseFor(second),
        secret: f.secret,
        now: () => now,
      });
      const observer = createVerifiedEmailObservation({
        enabled: true,
        providerId: "postmark",
        now: () => now,
        writer: async (input) => {
          captures.push(input);
          const result = await writer(input);
          outcomes.push(result.type);
          return result;
        },
      });
      const request = new Request(
        `https://claim.example.test/api/auth/callback/postmark?email=${address}&token=${rawToken}`,
        { method: "POST" },
      );
      const response = await observer.run(request, () =>
        runWithOAuthContainmentRequest(request, () =>
          Auth(request, {
            adapter: observer.wrapAdapter(
              createOAuthContainmentAdapter(adapter),
            ),
            secret: authSecret,
            trustHost: true,
            basePath: "/api/auth",
            providers: [
              Postmark({
                apiKey: "synthetic",
                from: "fixture@example.test",
                sendVerificationRequest: async () => {
                  throw new Error("Provider forbidden");
                },
              }),
            ],
            events: { signIn: observer.wrapSignIn(async () => {}) },
            logger: { error: () => {}, warn: () => {}, debug: () => {} },
          }),
        ),
      );
      expect(response.status).toBe(302);
      expect(outcomes).toEqual(["Recorded"]);
      expect(captures).toHaveLength(1);
      const captured = captures[0]!;
      expect(response.headers.get("set-cookie")).toContain(
        captured.sessionToken,
      );
      const http = createEvergreenClaimHttp({
        enabled: true,
        origin: "https://claim.example.test",
        productPath: "/products/course",
        secret: f.secret,
        getSessionAndUser: adapter.getSessionAndUser!,
        application: api,
        now: () => now,
      });
      const cookie = `__Secure-authjs.session-token=${captured.sessionToken}`,
        url = "https://claim.example.test/api/evergreen/claim";
      const priorClaims = await claims();
      const get = await http(new Request(url, { headers: { cookie } }));
      const body = await get.json();
      expect(body.status).toBe(expectedStatus);
      expect(await claims()).toEqual(priorClaims);
      const post = await http(
        new Request(url, {
          method: "POST",
          headers: {
            cookie,
            Origin: "https://claim.example.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ csrf: body.csrf }),
        }),
      );
      expect((await post.json()).status).toBe("pending");
      expect(await claims()).toHaveLength(priorClaims.length + 1);
      const coupons = await database.select().from(schema.coupon);
      expect(coupons).toHaveLength(1);
      expect(coupons[0]!.usedCount).toBe(0);
      expect(await database.select().from(schema.entitlements)).toHaveLength(0);
      return { http, cookie, url, body, captured };
    } finally {
      vi.useRealTimers();
    }
  }
  it("actual pinned Auth callback session and SQL adapter cross the CSRF boundary without issuing a coupon", async () => {
    await actualLoginAndClaim();
  });
  it("actual Auth/CSRF source recovers failed advance, rescans later lower ID and grants exactly once through runtime", async () => {
    fault = true;
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const choices = Array.from({ length: 16 }, (_, n) => {
      const token = `real-callback-fixture-${n}`;
      const attestationEventId = `elog_${hash(loginSemanticKey({ contactId: f.identity.contactId, tokenHash: emailTokenHash(f.secret, hash(token + "synthetic-auth-secret")) }))}`;
      return {
        token,
        id: `eoc_${hash(claimSemanticKey({ journeyId: f.issueIntent.journeyId, verifiedUserId: f.login.userId, attestationEventId }))}`,
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const low = choices[0]!,
      high = choices.at(-1)!;
    const first = await actualLoginAndClaim(high.token);
    const saved = (await claims())[0]!;
    expect(saved.id).toBe(high.id);
    expect(await database.select().from(schema.entitlements)).toHaveLength(0);
    const post = () =>
      first.http(
        new Request(first.url, {
          method: "POST",
          headers: {
            cookie: first.cookie,
            Origin: "https://claim.example.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ csrf: first.body.csrf }),
        }),
      );
    await Promise.all([post(), post()]);
    expect(await claims()).toEqual([saved]);
    const bindingIntents = () =>
      database
        .select()
        .from(journeySchema.evergreenOfferJourneyIntent)
        .where(
          eq(
            journeySchema.evergreenOfferJourneyIntent.intentType,
            "BindCoupon",
          ),
        );
    expect(await bindingIntents()).toHaveLength(0); // source persisted despite producer advance failure
    const firstSweep = await Effect.runPromise(
      reconstructedRuntime().claimSource("claim-proof", {}),
    );
    expect(firstSweep).toMatchObject({
      type: "RecoveryPage",
      page: { type: "Scanned", scanned: 1, cursor: high.id },
    });
    expect(
      await Effect.runPromise(
        reconstructedRuntime().claimSource("claim-proof", { after: high.id }),
      ),
    ).toMatchObject({ page: { scanned: 0, cursor: null } });
    expect(await bindingIntents()).toHaveLength(1);
    // First sweep already planned binding. Pending is truthful, not a readiness failure.
    await actualLoginAndClaim(low.token, false, "pending");
    expect((await claims()).map((row) => row.id).sort()).toEqual([
      low.id,
      high.id,
    ]);
    // A persisted high watermark misses this real new source. Completed sweep resets it.
    expect(
      await Effect.runPromise(
        reconstructedRuntime().claimSource("claim-proof", { after: high.id }),
      ),
    ).toMatchObject({ page: { scanned: 0, cursor: null } });
    expect(
      await Effect.runPromise(
        reconstructedRuntime().claimSource("claim-proof", {}),
      ),
    ).toMatchObject({ page: { scanned: 1, cursor: low.id } });
    const beforeBinding = await claims();
    const ticks = await Promise.all([
      Effect.runPromise(
        reconstructedRuntime().tick({
          generation: "claim-proof",
          lane: "intents",
        }),
      ),
      Effect.runPromise(
        reconstructedRuntime().tick({
          generation: "claim-proof",
          lane: "intents",
        }),
      ),
    ]);
    expect(ticks.map((result) => result.reason)).toContain("Coupon:Committed");
    const grants = await database.select().from(schema.entitlements);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.userId).toBe(first.captured.userId);
    expect(grants[0]!.expiresAt?.toISOString()).toBe(f.issueIntent.expiresAt);
    const couponRows = await database.select().from(schema.coupon);
    expect(couponRows).toHaveLength(1);
    expect(couponRows[0]!.expires?.toISOString()).toBe(f.issueIntent.expiresAt);
    const attempts = await database
      .select()
      .from(journeySchema.evergreenOfferJourneyAttempt);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("Accepted");
    await Effect.runPromise(
      reconstructedRuntime().claimSource("claim-proof", {}),
    );
    await Effect.runPromise(
      reconstructedRuntime().tick({
        generation: "claim-proof",
        lane: "intents",
      }),
    );
    expect(await database.select().from(schema.entitlements)).toEqual(grants);
    expect(await claims()).toEqual(beforeBinding);
  });
  it.each(["ownership", "control", "purchase"] as const)(
    "actual callback source never grants after %s changes before runtime replay",
    async (change) => {
      fault = true;
      await actualLoginAndClaim();
      const saved = await claims();
      if (change === "ownership")
        await database
          .update(schema.users)
          .set({ email: "changed@example.test", emailVerified: null });
      if (change === "control") stopped = true;
      if (change === "purchase") purchased = true;
      await Effect.runPromise(
        reconstructedRuntime().claimSource("claim-proof", {}),
      );
      await Effect.runPromise(
        reconstructedRuntime().tick({
          generation: "claim-proof",
          lane: "intents",
        }),
      );
      expect(await database.select().from(schema.entitlements)).toHaveLength(0);
      expect(await claims()).toEqual(saved);
      const coupons = await database.select().from(schema.coupon);
      expect(coupons).toHaveLength(1);
      expect(coupons[0]!.expires?.toISOString()).toBe(f.issueIntent.expiresAt);
    },
  );
  it.each(["AI_User", "AI_Contact", "AI_EvergreenOfferJourneyCommit"])(
    "holds %s locks through source commit on another physical connection",
    async (table) => {
      let entered!: () => void, release!: () => void;
      const atCommit = new Promise<void>((r) => (entered = r)),
        gate = new Promise<void>((r) => (release = r));
      beforeCommit = async () => {
        entered();
        await gate;
      };
      const claim = api.claim(session());
      await atCommit;
      let completed = false;
      const contender = second
        .query(`SELECT * FROM ${table} FOR UPDATE`)
        .then(() => {
          completed = true;
        });
      try {
        await new Promise((r) => setTimeout(r, 50));
        expect(completed).toBe(false);
      } finally {
        release();
        await claim;
        await contender;
      }
      expect(await claims()).toHaveLength(1);
    },
  );
  it("concurrent claims preserve one source", async () => {
    const results = await Promise.all([
      api.claim(session()),
      api.claim(session()),
    ]);
    expect(results).toContain("pending");
    expect(await claims()).toHaveLength(1);
  });
});
