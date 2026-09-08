import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import mysql, { type Pool } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { Effect } from "effect";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import * as journeySchema from "@/db/evergreen-offer-journey-schema";
import { contactEvent, providerIdentity } from "@/db/schema";
import { preserveQueryResultShape } from "@/db/mysql-query-client";
import { validateMySqlIntegrationServerUrl } from "../../team-purchase-mysql-test-guard";
import { commerceDdl } from "./coupon-executor-commerce.fixtures";
import {
  couponCommerceSchema,
  createMySqlCouponCommerceStore,
  createMySqlCouponReceiptReadStore,
} from "./coupon-authority-mysql";
import { createCouponAuthority } from "./coupon-authority";
import { createCouponReceiptReader } from "./coupon-receipt-reader";
import { createCouponIntentExecutor } from "./coupon-executor";
import { createDrizzleJourneyLedger } from "./drizzle-ledger";
import { createDrizzleJourneyAttempts } from "./drizzle-attempts";
import { createEvergreenOfferJourneyService } from "./service";
import {
  createBoundedJourneyReaders,
  restoreSourceCandidate,
} from "./bounded-readers";
import { currentCourseSourceFixture } from "./bounded-readers.fixtures";
import { syntheticRevisionScope } from "./revision-delivery.fixtures";
import { createRevisionDelivery } from "./revision-delivery";
import {
  createOriginalDeliveryMapping,
  createMySqlOriginalMappingPersistence,
} from "./original-delivery-mapping-mysql";
import {
  EVERGREEN_OFFER_JOURNEY_V1,
  EVERGREEN_OFFER_JOURNEY_V2,
} from "./definition";
import { createBridgeRuntime, type BridgeTickRequest } from "./bridge-runtime";
import { deriveJourneyId, parseIsoInstant } from "./primitives";
import type { EligibilityFacts } from "./domain";

const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL;
// All cases in this file require the explicitly guarded disposable MySQL server.
describe.skipIf(!serverUrl)(
  "runtime real source-to-expiry composition with synthetic merchant/Kit",
  () => {
    let server: Pool, pool: Pool, name: string;
    beforeAll(async () => {
      const safe = validateMySqlIntegrationServerUrl(serverUrl!, {
        nodeEnv: process.env.NODE_ENV,
        vercelEnv: process.env.VERCEL_ENV,
      });
      server = mysql.createPool({
        uri: safe.toString(),
        multipleStatements: true,
        timezone: "Z",
        connectionLimit: 1,
      });
      name = `aih_runtime_${randomUUID().replaceAll("-", "")}`;
      await server.query(
        `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      await server.query(`USE \`${name}\``);
      for (const migration of [
        "20260504_ai_hero_subscriber_marketing_gate_a.sql",
        "20260714_ai_hero_optin_attribution.sql",
        "20260717_ai_hero_side_effect_intent_completed_at.sql",
        "20260831_ai_hero_email_course_evergreen_schema.sql",
        "20260907_evergreen_admission_attempts.sql",
      ])
        await server.query(
          await fs.readFile(
            new URL(`../../../db/migrations/${migration}`, import.meta.url),
            "utf8",
          ),
        );
      for (const ddl of commerceDdl.filter(
        (s) => !s.startsWith("CREATE TABLE AI_Contact "),
      ))
        await server.query(ddl);
      const uri = new URL(safe);
      uri.pathname = `/${name}`;
      pool = preserveQueryResultShape(
        mysql.createPool({
          uri: uri.toString(),
          connectionLimit: 4,
          timezone: "Z",
        }),
      );
    });
    afterAll(async () => {
      await pool?.end();
      if (name) await server.query(`DROP DATABASE \`${name}\``);
      await server?.end();
    });
    it("admits exact source once, delivers 3+5 claimed slots, issues original coupon and expires without new newsletter mutation", async () => {
      const database = drizzle(pool, {
        schema: journeySchema,
        mode: "planetscale",
      });
      const commerce = drizzle(pool, {
        schema: couponCommerceSchema,
        mode: "planetscale",
      });
      const ledger = createDrizzleJourneyLedger(database),
        attempts = createDrizzleJourneyAttempts(database);
      const source = currentCourseSourceFixture(),
        entry = restoreSourceCandidate(source)!;
      await server.query("INSERT INTO AI_Contact (id,email) VALUES (?,?)", [
        entry.contactId,
        "runtime@example.test",
      ]);
      await database
        .insert(providerIdentity)
        .values({
          id: source.providerIdentityId,
          contactId: entry.contactId,
          provider: "ai-hero",
          externalId: "runtime-test",
          evidence: { source: "synthetic" },
        });
      await database.insert(contactEvent).values(source);
      const merchant = {
        id: "runtime-merchant",
        identifier: "fixture",
        merchantAccountId: "fixture-account",
        currency: "USD",
        amountOffCents: 10000,
        type: "special",
        sourceReference: "synthetic-not-provider-proof",
      };
      await commerce
        .insert(couponCommerceSchema.merchantCoupon)
        .values({
          id: merchant.id,
          identifier: merchant.identifier,
          merchantAccountId: merchant.merchantAccountId,
          status: 1,
          amountDiscount: 10000,
          type: "special",
        });
      let now = entry.exhaustedAt;
      const clock = {
        now: Effect.sync(() => {
          const result = parseIsoInstant(now);
          if (!result.ok) throw new Error("Invalid fixture clock");
          return result.value;
        }),
      };
      const authority = {
        currentFacts: ({
          journeyId,
        }: {
          journeyId: EligibilityFacts["existingJourneyId"];
        }) =>
          Effect.succeed({
            contactId: entry.contactId,
            purchase: null,
            delivery: { type: "Eligible" as const },
            existingJourneyId: journeyId,
            automationControl: { type: "Enabled" as const, version: "test" },
            evidenceVersion: "fixture-current",
            readAt: now,
          }),
      };
      const service = createEvergreenOfferJourneyService({
        ledger,
        authority,
        clock,
        definition: EVERGREEN_OFFER_JOURNEY_V2,
      });
      const mapping = createOriginalDeliveryMapping({
        store: createMySqlOriginalMappingPersistence(database),
        now: () => now,
      });
      const bundles = [
        EVERGREEN_OFFER_JOURNEY_V1,
        EVERGREEN_OFFER_JOURNEY_V2,
      ].map((definition) => {
        const manifest = syntheticRevisionScope(definition).manifest;
        return {
          manifest,
          originalMapping: mapping.reader,
          mappingWriter: mapping.writer,
          providerReadbacks: manifest.messages.map((m) => ({
            sequenceId: m.sequenceId,
            repeat: false as const,
            emailCount: 1 as const,
            published: true as const,
            active: true as const,
            hold: false as const,
          })),
        };
      });
      const posts: string[] = [];
      const messages = createRevisionDelivery({
        bundles,
        dependencies: { ledger, attempts, authority, clock, service },
        now: () => now,
        kit: {
          apiKey: "fixture-no-network",
          resolveIdentity: async (contactId) => ({
            contactId,
            subscriberId: 91,
          }),
          fetch: (async (url, init) => {
            expect(init?.method).toBe("POST");
            posts.push(String(url));
            return new Response(
              JSON.stringify({ subscriber: { id: 91, state: "active" } }),
              { status: 201 },
            );
          }) as typeof fetch,
        },
      });
      expect(messages.registry().type).toBe("Configured");
      const coupons = createCouponIntentExecutor({
        ledger,
        attempts,
        service,
        authority,
        clock,
        coupons: createCouponAuthority({
          store: createMySqlCouponCommerceStore(commerce),
          merchantCouponEvidence: merchant,
          now: () => now,
        }),
        receipts: createCouponReceiptReader(
          createMySqlCouponReceiptReadStore(commerce),
        ),
      });
      const readers = createBoundedJourneyReaders(database, ledger);
      const build = () =>
        createBridgeRuntime({
          readers,
          messages,
          coupons,
          service,
          clock,
          control: () =>
            Effect.succeed({ type: "Enabled", generation: "fixture" }),
        });
      let runtime = build();
      const sourceRequest = { generation: "fixture", lane: "source" as const };
      expect((await Effect.runPromise(runtime.tick(sourceRequest))).type).toBe(
        "Progress",
      );
      await Effect.runPromise(runtime.tick(sourceRequest));
      const journeyId = deriveJourneyId(entry.entryFactId);
      const entered = await Effect.runPromise(ledger.load(journeyId));
      if (!entered || !("messagePlan" in entered))
        throw new Error("Missing entered journey");
      expect(entered.definition.definitionVersion).toBe("evergreen-offer-v2");
      async function drain(lane: "wakes" | "intents") {
        let request: BridgeTickRequest = { generation: "fixture", lane };
        for (let page = 0; page < 32; page++) {
          const result = await Effect.runPromise(runtime.tick(request));
          if (result.reason === "ShadowHandoffExecutorUnavailable")
            return result;
          expect(result.type).toBe("Progress");
          if (!result.continuation.after) return result;
          request = result.continuation;
        }
        throw new Error("Bounded fixture page budget exceeded");
      }
      for (const slot of entered.messagePlan.bridge) {
        now = slot.dueAt;
        await drain("wakes");
        await drain("intents");
        runtime = build(); // restart; committed attempts, not process memory, prevent sends
        await drain("intents");
      }
      expect(posts).toHaveLength(3);
      now = entered.messagePlan.bridge[2].windowEndsAt;
      await drain("wakes");
      await drain("intents");
      const issued = await Effect.runPromise(ledger.load(journeyId));
      if (!issued || !("coupon" in issued) || !issued.coupon)
        throw new Error("Missing coupon receipt");
      const expiry = issued.coupon.expiresAt;
      for (const slot of issued.messagePlan.pitch) {
        now = slot.dueAt;
        await drain("wakes");
        await drain("intents");
      }
      expect(posts).toHaveLength(8);
      now = expiry;
      await drain("wakes");
      const terminal = await Effect.runPromise(ledger.load(journeyId));
      expect(terminal?.phase).toBe("handoff.awaitingReceipt");
      expect((await drain("intents"))?.reason).toBe(
        "ShadowHandoffExecutorUnavailable",
      );
      expect(posts).toHaveLength(8);
      const rows = await commerce.select().from(couponCommerceSchema.coupon);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.expires?.toISOString()).toBe(expiry);
    });
  },
);
