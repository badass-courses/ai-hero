import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import mysql, { type Pool } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import type { MySqlDatabase } from "drizzle-orm/mysql-core";
import { automationControl } from "@/db/email-course-schema";
import { and, eq, asc } from "drizzle-orm";
import { Effect } from "effect";
import { compileMessageTemplate } from "@/lib/subscriber-marketing/evergreen-offer-journey/message-preparation";
import * as revisionDelivery from "@/lib/subscriber-marketing/evergreen-offer-journey/revision-delivery";
import { Auth } from "@auth/core";
import Postmark from "@auth/core/providers/postmark";
import { DrizzleAdapter } from "@coursebuilder/adapter-drizzle";
import { mysqlTable } from "@/db/mysql-table";
import { preserveQueryResultShape } from "@/db/mysql-query-client";
import * as schema from "@/db/schema";
import * as journeySchema from "@/db/evergreen-offer-journey-schema";
import { validateMySqlIntegrationServerUrl } from "@/lib/team-purchase-mysql-test-guard";
import { contactEmailWriteValues } from "@/lib/subscriber-marketing/contact-email-equivalence";
import { sourceFixture } from "@/lib/subscriber-marketing/evergreen-offer-journey/bounded-readers.fixtures";
import { commerceDdl } from "@/lib/subscriber-marketing/evergreen-offer-journey/coupon-executor-commerce.fixtures";
import { createDrizzleJourneyLedger } from "@/lib/subscriber-marketing/evergreen-offer-journey/drizzle-ledger";
import { parseJourneyId } from "@/lib/subscriber-marketing/evergreen-offer-journey/primitives";
import { pilotFixture } from "./evergreen-pilot.fixtures";
import {
  evergreenPilotClaim,
  runEvergreenPilotCommand,
  createEvergreenPilotEmailObservation,
} from "./evergreen-pilot";
import {
  createOAuthContainmentAdapter,
  runWithOAuthContainmentRequest,
} from "./oauth-link-containment";

let pool: Pool;
const handles = () =>
  drizzle(preserveQueryResultShape(pool), {
    schema: { ...schema, ...journeySchema },
    mode: "planetscale",
  });
const adapter = () =>
  DrizzleAdapter<MySqlDatabase<any, any, any>>(handles(), mysqlTable);
// Only infrastructure inputs are replaced. loadEvergreenPilot, composition,
// authority, owned transactions, Auth/claim adapters and executors are real.
vi.mock("@/db", () => ({
  createDatabaseHandle: (tables: Record<string, unknown>) =>
    drizzle(preserveQueryResultShape(pool), {
      schema: tables,
      mode: "planetscale",
    }),
  acquireDatabaseConnection: () => pool.getConnection(),
  closeDatabasePool: async () => {},
  courseBuilderAdapter: {
    getSessionAndUser: (token: string) => adapter().getSessionAndUser!(token),
  },
}));
vi.mock("@/env.mjs", () => ({
  env: {
    NEXTAUTH_SECRET: "synthetic-auth-secret",
    NEXT_PUBLIC_URL: "https://claim.example.test",
    CONVERTKIT_API_SECRET: "synthetic-kit-secret",
  },
}));
const serverUrl = process.env.AIH_EVERGREEN_JOURNEY_MYSQL_TEST_SERVER_URL;

describe.skipIf(!serverUrl)(
  "actual bounded application pilot / disposable SQL and synthetic provider",
  () => {
    let server: Pool,
      name: string,
      f: ReturnType<typeof pilotFixture>,
      now: Date;
    const actualDelivery = revisionDelivery.createRevisionDelivery;
    let deliveries: unknown[];
    let posts: number,
      puts: number,
      reads: string[],
      fields: Record<string, string>;
    beforeAll(async () => {
      const safe = validateMySqlIntegrationServerUrl(serverUrl!, {
        nodeEnv: process.env.NODE_ENV,
        vercelEnv: process.env.VERCEL_ENV,
      });
      server = mysql.createPool({ uri: safe.toString(), timezone: "Z" });
      name = `aih_pilot_test_${randomUUID().replaceAll("-", "")}`;
      await server.query(
        `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
      );
      const uri = new URL(safe);
      uri.pathname = `/${name}`;
      pool = mysql.createPool({
        uri: uri.toString(),
        timezone: "Z",
        connectionLimit: 8,
        multipleStatements: true,
      });
      for (const file of [
        "20260504_ai_hero_subscriber_marketing_gate_a.sql",
        "20260714_ai_hero_optin_attribution.sql",
        "20260717_ai_hero_side_effect_intent_completed_at.sql",
        "plans/20260908_contact_email_equivalence.sql",
        "20260831_ai_hero_email_course_evergreen_schema.sql",
        "20260907_evergreen_admission_attempts.sql",
      ]) {
        await pool.query(
          await fs.readFile(
            new URL(`../db/migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      }
      for (const ddl of commerceDdl.slice(1)) await pool.query(ddl);
      for (const ddl of [
        "CREATE TABLE AI_Session (sessionToken varchar(255) PRIMARY KEY,userId varchar(255) NOT NULL,expires timestamp NOT NULL)",
        "CREATE TABLE AI_VerificationToken (identifier varchar(255) NOT NULL,token varchar(255) NOT NULL,expires timestamp NOT NULL,createdAt timestamp(3) DEFAULT CURRENT_TIMESTAMP(3),PRIMARY KEY(identifier,token))",
        "CREATE TABLE AI_Purchase (id varchar(191) PRIMARY KEY, productId varchar(191), userId varchar(191), status varchar(191), createdAt timestamp(3))",
        "CREATE TABLE AI_ContentResourceProduct (resourceId varchar(191),productId varchar(191))",
        "CREATE TABLE AI_OrganizationMembership (id varchar(191) PRIMARY KEY,userId varchar(191))",
        "CREATE TABLE AI_Price (id varchar(191) PRIMARY KEY, productId varchar(191), organizationId varchar(191), nickname varchar(191), status int NOT NULL DEFAULT 0, unitAmount decimal(10,2) NOT NULL, createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), fields json)",
      ])
        await pool.query(ddl);
    });
    beforeEach(async () => {
      deliveries = [];
      vi.spyOn(revisionDelivery, "createRevisionDelivery").mockImplementation(
        (input) => {
          const real = actualDelivery(input);
          return {
            ...real,
            execute: (target) =>
              Effect.tap(real.execute(target), (value) =>
                Effect.sync(() => {
                  deliveries.push(value);
                }),
              ),
          };
        },
      );
      f = pilotFixture();
      now = new Date(f.entry.decidedAt);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      vi.stubEnv("AIH_EVERGREEN_PILOT_CONFIG_JSON", JSON.stringify(f.value));
      vi.stubEnv("CONVERTKIT_V4_API_KEY", "synthetic-kit-key");
      for (const t of [
        "AI_VerificationToken",
        "AI_Session",
        "AI_Entitlement",
        "AI_EntitlementType",
        "AI_Coupon",
        "AI_MerchantCoupon",
        "AI_User",
        "AI_ContactEvent",
        "AI_ProviderIdentity",
        "AI_ContactState",
        "AI_Contact",
        "AI_AutomationControl",
        "AI_EvergreenOfferJourneyAttempt",
        "AI_EvergreenOfferJourneyIntent",
        "AI_EvergreenOfferJourneyWake",
        "AI_EvergreenOfferJourneyCommit",
        "AI_ContentResourceProduct",
        "AI_Price",
        "AI_Purchase",
      ])
        await pool.query(`DELETE FROM \`${t}\``);
      const db = handles();
      const row = sourceFixture("preparation-fixture");
      await db.insert(schema.contact).values({
        id: row.contactId,
        ...contactEmailWriteValues("pilot@example.test"),
        userId: f.config.userId,
        lifecycle: "new",
      });
      await db.insert(schema.users).values({
        id: f.config.userId,
        email: "pilot@example.test",
        name: "Synthetic Pilot",
        emailVerified: now,
      });
      await db.insert(schema.providerIdentity).values({
        id: row.providerIdentityId,
        contactId: row.contactId,
        provider: "kit",
        externalId: "123",
        evidence: { source: "kit", strength: "strong" },
      });
      await db.insert(schema.contactEvent).values(row);
      await pool.query(
        'INSERT INTO AI_ContactState (id,contactId,lifecycle,primaryBucket,allBuckets,whySignals,whoSignals,confidence,rationale,reviewSignals,lastEventId,schemaVersion) VALUES (?,?,"new","synthetic",JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),1,JSON_ARRAY(),JSON_ARRAY(),?,1)',
        ["pilot-state", row.contactId, row.id],
      );
      await db.insert(automationControl).values({
        automationId: f.config.automationId,
        control: {
          type: "Enabled",
          version: f.config.generation,
          enabledAt: now.toISOString(),
        },
      });
      await db.insert(schema.merchantCoupon).values({
        id: f.config.merchantCouponEvidence.id,
        identifier: "synthetic",
        merchantAccountId: "synthetic",
        amountDiscount: 10000,
        status: 1,
        type: "special",
      });
      await db
        .insert(schema.entitlementTypes)
        .values({ id: "pilot-credit-type", name: "apply_special_credit" });
      await pool.query(
        'INSERT INTO AI_ContentResourceProduct (resourceId,productId) VALUES ("synthetic-workshop","product-ma254")',
      );
      await pool.query(
        'INSERT INTO AI_Price (id,productId,unitAmount) VALUES ("synthetic-price","product-ma254",299)',
      );
      posts = 0;
      puts = 0;
      reads = [];
      fields = { pref_newsletter: "subscribed" };
      // Synthetic account already has the reviewed field definitions. The real
      // transport must refuse absent keys and must never provision them itself.
      for (const template of f.config.templates) {
        const compiled = compileMessageTemplate(template, {
          FIRST_NAME: "synthetic",
          REGULAR_PRICE: "synthetic",
          DISCOUNT_AMOUNT: "synthetic",
          DEADLINE_DISPLAY: "synthetic",
        });
        for (const key of Object.keys(compiled.fields)) fields[key] = "";
      }
      vi.stubGlobal(
        "fetch",
        async (request: string | URL | Request, init?: RequestInit) => {
          const url = String(request);
          reads.push(url);
          expect(url).not.toContain("/999");
          if (init?.method === "PUT") {
            puts++;
            Object.assign(fields, JSON.parse(String(init.body)).fields);
          }
          if (init?.method === "POST") posts++;
          const body = url.includes("/tags")
            ? {
                tags: [],
                pagination: {
                  has_previous_page: false,
                  has_next_page: false,
                  start_cursor: null,
                  end_cursor: null,
                  per_page: 100,
                },
              }
            : {
                subscriber: {
                  id: 123,
                  email_address: "pilot@example.test",
                  first_name: "Synthetic Pilot",
                  state: "active",
                  fields,
                  canceled_at: null,
                },
              };
          const response = Response.json(body, {
            status: init?.method === "POST" ? 201 : 200,
          });
          Object.defineProperties(response, {
            url: { value: url },
            type: { value: "basic" },
          });
          return response;
        },
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    afterAll(async () => {
      await pool?.end();
      if (server && name) await server.query(`DROP DATABASE \`${name}\``);
      await server?.end();
    });
    const scan = (lane: "source" | "wakes" | "intents") =>
      runEvergreenPilotCommand({
        type: "scan",
        request: { generation: f.config.generation, lane },
      });
    async function snapshot() {
      const id = parseJourneyId(f.config.journeyId);
      if (!id.ok) throw new Error("fixture journey");
      return Effect.runPromise(
        createDrizzleJourneyLedger(handles()).load(id.value),
      );
    }
    async function reachPitch() {
      expect(await scan("source")).toMatchObject({
        type: "Progress",
        reason: "SourceFolded",
        scanned: 1,
      });
      for (let n = 0; n < 20; n++) {
        const wake = await scan("wakes"),
          intent = await scan("intents");
        expect(wake, JSON.stringify(wake)).toMatchObject({ type: "Progress" });
        expect(
          intent,
          JSON.stringify({ intent, deliveries, posts, puts }),
        ).toMatchObject({
          type: "Progress",
        });
        const state = await snapshot();
        if (state?.phase === "pitch.running" && state.coupon) return state;
        const next = (
          await handles()
            .select()
            .from(journeySchema.evergreenOfferJourneyWake)
            .where(
              and(
                eq(
                  journeySchema.evergreenOfferJourneyWake.journeyId,
                  f.config.journeyId,
                ),
                eq(journeySchema.evergreenOfferJourneyWake.status, "Pending"),
              ),
            )
            .orderBy(asc(journeySchema.evergreenOfferJourneyWake.dueAt))
            .limit(1)
        )[0];
        if (next && next.dueAt > now) {
          now = next.dueAt;
          vi.setSystemTime(now);
        }
      }
      throw new Error(`Pilot failed to reach pitch after 20 bounded steps`);
    }
    async function login(address = "pilot@example.test") {
      const a = adapter(),
        rawToken = "synthetic-login-token";
      await a.createVerificationToken!({
        identifier: address,
        token: createHash("sha256")
          .update(rawToken + "synthetic-auth-secret")
          .digest("hex"),
        expires: new Date(now.getTime() + 60000),
      });
      const observer = createEvergreenPilotEmailObservation();
      const request = new Request(
        `https://claim.example.test/api/auth/callback/postmark?email=${address}&token=${rawToken}`,
      );
      const response = await observer.run(request, () =>
        runWithOAuthContainmentRequest(request, () =>
          Auth(request, {
            secret: "synthetic-auth-secret",
            trustHost: true,
            basePath: "/api/auth",
            session: { strategy: "database" },
            adapter: observer.wrapAdapter(createOAuthContainmentAdapter(a)),
            providers: [
              Postmark({
                apiKey: "synthetic",
                from: "synthetic@example.test",
                sendVerificationRequest: async () => {
                  throw new Error("Auth send forbidden");
                },
              }),
            ],
            events: { signIn: observer.wrapSignIn(async () => {}) },
          }),
        ),
      );
      expect(response.status).toBe(302);
      const cookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith("__Secure-authjs.session-token="))
        ?.split(";")[0];
      expect(cookie).toBeTruthy();
      return cookie!;
    }
    const request = (cookie: string, csrf?: string) =>
      new Request("https://claim.example.test/api/evergreen/claim", {
        method: csrf ? "POST" : "GET",
        headers: {
          cookie,
          origin: "https://claim.example.test",
          ...(csrf ? { "content-type": "application/json" } : {}),
        },
        body: csrf ? JSON.stringify({ csrf }) : undefined,
      });
    it("real application assembly admits only scoped source, prepares three messages, then actual Auth/claim binds once", async () => {
      const foreign = sourceFixture("foreign");
      await handles().insert(schema.contactEvent).values(foreign);
      const pitched = await reachPitch();
      expect(posts).toBe(3);
      expect(puts).toBe(3);
      const cookie = await login();
      const before = await handles().select().from(schema.contactEvent);
      const get = await evergreenPilotClaim(request(cookie));
      expect(get.status).toBe(200);
      const body = await get.json();
      expect(body.status).toBe("ready");
      expect(await handles().select().from(schema.contactEvent)).toEqual(
        before,
      );
      expect(
        (await evergreenPilotClaim(request(cookie, "invalid"))).status,
      ).toBe(403);
      expect(await handles().select().from(schema.contactEvent)).toEqual(
        before,
      );
      expect(
        (await evergreenPilotClaim(request(cookie, body.csrf))).status,
      ).toBe(200);
      await runEvergreenPilotCommand({
        type: "claimSource",
        generation: f.config.generation,
        input: { limit: 1 },
      });
      for (let i = 0; i < 3; i++) await scan("intents");
      const grants = await handles().select().from(schema.entitlements);
      expect(grants).toHaveLength(1);
      expect(grants[0]!.userId).toBe(f.config.userId);
      expect(grants[0]!.expiresAt?.toISOString()).toBe(
        pitched.coupon!.expiresAt,
      );
      await evergreenPilotClaim(
        request(
          cookie,
          (await (await evergreenPilotClaim(request(cookie))).json()).csrf,
        ),
      );
      await scan("intents");
      expect(await handles().select().from(schema.entitlements)).toEqual(
        grants,
      );
      const commits = await handles()
        .select()
        .from(journeySchema.evergreenOfferJourneyCommit);
      expect(new Set(commits.map((c) => c.journeyId))).toEqual(
        new Set([f.config.journeyId]),
      );
    });
    it("missing pre-existing field definitions stays held without a PUT or enrollment", async () => {
      fields = { pref_newsletter: "subscribed" };
      await scan("source");
      now = new Date(f.now);
      vi.setSystemTime(now);
      await scan("wakes");
      expect(await scan("intents")).toMatchObject({
        type: "Paused",
        reason: "Message:Abandoned",
      });
      expect(deliveries).toContainEqual(
        expect.objectContaining({
          type: "Abandoned",
          detail: "FieldProjectionUnconfirmed",
        }),
      );
      expect(puts + posts).toBe(0);
    });
    it("unrelated actual email login succeeds without adding an observation or claim", async () => {
      await handles().insert(schema.users).values({
        id: "foreign-user",
        email: "foreign@example.test",
        emailVerified: now,
      });
      const before = await handles().select().from(schema.contactEvent);
      const cookie = await login("foreign@example.test");
      expect((await evergreenPilotClaim(request(cookie))).status).toBe(401);
      expect(await handles().select().from(schema.contactEvent)).toEqual(
        before,
      );
      expect(reads).toEqual([]);
      expect(posts + puts).toBe(0);
    });
    it.each(["missing-source", "wrong-contact", "generation", "stopped"])(
      "%s prevents all runtime/provider work",
      async (mode) => {
        if (mode === "missing-source")
          await handles().delete(schema.contactEvent);
        if (mode === "wrong-contact")
          vi.stubEnv(
            "AIH_EVERGREEN_PILOT_CONFIG_JSON",
            JSON.stringify({ ...f.value, contactId: "other" }),
          );
        if (mode === "generation")
          vi.stubEnv(
            "AIH_EVERGREEN_PILOT_CONFIG_JSON",
            JSON.stringify({ ...f.value, generation: "other" }),
          );
        if (mode === "stopped") await handles().delete(automationControl);
        expect(await scan("source")).toEqual({ type: "Disabled" });
        expect((await evergreenPilotClaim(request(""))).status).toBe(404);
        expect(
          await handles()
            .select()
            .from(journeySchema.evergreenOfferJourneyCommit),
        ).toEqual([]);
        expect(reads).toEqual([]);
      },
    );
    it.each(["ownership", "expiry", "control"])(
      "current %s change holds a composed claim without a grant",
      async (mode) => {
        await reachPitch();
        const cookie = await login();
        const body = await (await evergreenPilotClaim(request(cookie))).json();
        expect(body.status).toBe("ready");
        if (mode === "ownership")
          await handles()
            .update(schema.users)
            .set({ email: "changed@example.test" })
            .where(eq(schema.users.id, f.config.userId));
        if (mode === "expiry") {
          now = new Date((await snapshot())!.coupon!.expiresAt);
          vi.setSystemTime(now);
        }
        if (mode === "control") await handles().delete(automationControl);
        const response = await evergreenPilotClaim(request(cookie, body.csrf));
        expect([200, 401, 403, 404]).toContain(response.status);
        expect(await handles().select().from(schema.entitlements)).toEqual([]);
        if (response.status === 200)
          expect((await response.json()).status).toBe("unavailable");
      },
    );
  },
);
