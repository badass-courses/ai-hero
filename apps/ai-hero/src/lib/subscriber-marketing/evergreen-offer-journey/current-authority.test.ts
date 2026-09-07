import { Effect, Either } from "effect";
import {
  emailPreferenceDefinitionByKey,
  DEFAULT_EMAIL_PREFERENCE_KEY,
} from "@/coursebuilder/email-preferences";
import { describe, expect, it, vi } from "vitest";
import {
  createCurrentOfferAuthority,
  createKitCurrentCommunicationReader,
  type CurrentAuthorityRepository,
  type ExhaustionRow,
} from "./current-authority";
import {
  parseContactId,
  parseJourneyId,
  parseEntryFactId,
  parseIsoInstant,
  parseStimulusId,
} from "./primitives";
import {
  COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
  courseSequenceExhaustionFactKey,
  readCoursePayload,
  restoreCourseSequenceExhaustedPayload,
} from "../course-sequence-exhaustion";
import { decideEvergreenOfferJourney } from "./decision";
import { EVERGREEN_OFFER_JOURNEY_V1 } from "./definition";

const parsed = parseContactId("contact-test");
if (!parsed.ok) throw new Error("Invalid fixture");
const contactId = parsed.value;
const at = new Date("2026-09-07T19:00:00.000Z");
function exhaustion(path = "ai-hero-skills-workflow"): ExhaustionRow {
  const prefix = path.endsWith("team-workflow") ? "team-email" : "email";
  const resource = (n: number) => `${path}.${prefix}-${n}`;
  const key = (n: number) =>
    `contact:${contactId}:value-path:${path}:email:${resource(n)}`;
  return {
    id: `fact-${path}`,
    contactId,
    eventType: "course.sequence-exhausted",
    semanticIdempotencyKey: courseSequenceExhaustionFactKey({
      contactId,
      valuePathId: path,
    }),
    payloadSummary: {
      coursePayload: {
        format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
        payload: {
          format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
          actor: {
            actorId: `email-course:${contactId}:${path}`,
            contactId,
            valuePathId: path,
            courseEntryEventId: "entry",
          },
          exhaustedAt: at.toISOString(),
          deadlineTimeZone: {
            type: "BrowserEntryHeader",
            headerName: "x-vercel-ip-timezone",
            timeZone: "America/Los_Angeles",
            capturedAt: at.toISOString(),
          },
          progression: {
            from: {
              intentId: "six",
              idempotencyKey: key(6),
              emailResourceId: resource(6),
              completedAt: "2026-09-06T18:00:00.000Z",
            },
            trigger: {
              type: "DailyDripDue",
              evaluatedAt: at.toISOString(),
              reason: "local-day-9am-due",
            },
            terminal: {
              intentId: "seven",
              idempotencyKey: key(7),
              nextActionId: "next-seven",
              emailResourceId: resource(7),
            },
          },
          sourceReferences: {
            courseEntryEventId: "entry",
            priorIntentId: "six",
          },
        },
      },
    },
  };
}
type Preference = Parameters<
  typeof createKitCurrentCommunicationReader
>[0]["preference"];
function fixture(
  preference: Preference = emailPreferenceDefinitionByKey[
    DEFAULT_EMAIL_PREFERENCE_KEY
  ],
) {
  const repository: CurrentAuthorityRepository = {
    readControl: vi.fn(async () => ({
      automationId: "evergreen-test",
      control: { type: "Enabled", version: "v1", enabledAt: at.toISOString() },
      updatedAt: at,
    })),
    readIdentity: vi.fn(async () => ({
      contact: {
        id: contactId,
        email: "student@example.com",
        userId: "user-test",
        lifecycle: "new",
      },
      states: [{ contactId, lifecycle: "new" }],
      links: [],
      providers: [{ contactId, provider: "kit" as const, externalId: "123" }],
      users: [{ id: "user-test", email: "student@example.com" }],
    })),
    readExhaustionFacts: vi.fn(async () => [exhaustion()]),
    readJourneyHeads: vi.fn(async () => []),
    readPurchases: vi.fn(async () => []),
  };
  const getSubscriber = vi.fn(
    async (): Promise<unknown> => ({
      id: 123,
      email_address: "student@example.com",
      state: "active",
      fields: { pref_newsletter: "subscribed" },
    }),
  );
  const communication = createKitCurrentCommunicationReader({
    getSubscriber,
    preference,
    now: () => at,
  });
  const authority = createCurrentOfferAuthority({
    repository,
    automationId: "evergreen-test",
    communication,
    now: () => at,
  });
  return { repository, getSubscriber, authority, communication };
}
const run = (authority: ReturnType<typeof createCurrentOfferAuthority>) =>
  Effect.runPromise(
    Effect.either(authority.currentFacts({ contactId, journeyId: null })),
  );

describe("current Evergreen authority", () => {
  it("reads known current provider state and exact control, with bounded path keys", async () => {
    const f = fixture();
    const result = await run(f.authority);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result))
      expect(result.right).toMatchObject({
        contactId,
        purchase: null,
        delivery: { type: "Eligible" },
        existingJourneyId: null,
        automationControl: { type: "Enabled", version: "v1" },
        readAt: at.toISOString(),
      });
    expect(f.repository.readExhaustionFacts).toHaveBeenCalledWith(
      ["ai-hero-skills-workflow", "ai-hero-skills-team-workflow"].map(
        (valuePathId) =>
          courseSequenceExhaustionFactKey({ contactId, valuePathId }),
      ),
    );
    expect(f.getSubscriber).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "malformed", "wrong-key", "null-payload"])(
    "fails closed for %s control",
    async (mode) => {
      const f = fixture();
      f.repository.readControl = async () =>
        mode === "missing"
          ? null
          : {
              automationId: mode === "wrong-key" ? "other" : "evergreen-test",
              control: mode === "null-payload" ? null : {},
              updatedAt: at,
            };
      expect(Either.isLeft(await run(f.authority))).toBe(true);
      expect(f.getSubscriber).not.toHaveBeenCalled();
    },
  );
  it("observes changed controls and purchases on the next read without caching", async () => {
    const f = fixture();
    expect(Either.isRight(await run(f.authority))).toBe(true);
    f.repository.readControl = async () => ({
      automationId: "evergreen-test",
      control: {
        type: "Stopped",
        version: "v2",
        reason: "operator-stop",
        stoppedAt: at.toISOString(),
      },
      updatedAt: at,
    });
    f.repository.readPurchases = async () => [
      {
        id: "purchase-test",
        productId: "product-ma254",
        userId: "user-test",
        status: "Valid",
        createdAt: at,
        via: "direct",
        beneficiaryUserId: "user-test",
        effectiveProductId: "product-ma254",
      },
    ];
    const second = await run(f.authority);
    expect(Either.isRight(second)).toBe(true);
    if (Either.isRight(second))
      expect(second.right).toMatchObject({
        automationControl: { type: "Stopped", version: "v2" },
        purchase: {
          purchaseId: "purchase-test",
          sourceProductId: "product-ma254",
        },
      });
    expect(f.getSubscriber).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["cancelled", "subscribed", "Unsubscribed"],
    ["bounced", "subscribed", "Undeliverable"],
    ["complained", "subscribed", "Undeliverable"],
    ["active", "unsubscribed", "Unsubscribed"],
  ])("maps current %s / %s to %s", async (state, preference, type) => {
    const f = fixture();
    f.getSubscriber.mockResolvedValue({
      id: 123,
      email_address: "student@example.com",
      state,
      fields: { pref_newsletter: preference },
    });
    const result = await run(f.authority);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right.delivery.type).toBe(type);
  });
  it.each(["inactive", "unknown"])(
    "never defaults incomplete %s provider evidence to subscribed",
    async (state) => {
      const f = fixture();
      f.getSubscriber.mockResolvedValue({
        id: 123,
        email_address: "student@example.com",
        state,
        fields: {},
      });
      expect(Either.isLeft(await run(f.authority))).toBe(true);
    },
  );
  it("preserves local suppression as a veto, not an allow source", async () => {
    const f = fixture();
    const rows = await f.repository.readIdentity(contactId);
    f.getSubscriber.mockResolvedValue({
      id: 123,
      email_address: "student@example.com",
      state: "active",
    });
    rows.states[0]!.lifecycle = "suppressed";
    f.repository.readIdentity = async () => rows;
    const result = await run(f.authority);
    if (Either.isRight(result))
      expect(result.right.delivery.type).toBe("Suppressed");
    else throw new Error(result.left.type);
  });
  it.each(["user", "link", "provider", "missing-state", "stale"])(
    "rejects conflicting or incomplete %s identity",
    async (mode) => {
      const f = fixture();
      const rows = await f.repository.readIdentity(contactId);
      if (mode === "stale") rows.states[0]!.lifecycle = "stale";
      if (mode === "user") rows.users[0]!.email = "other@example.com";
      if (mode === "link") rows.links.push({ contactId, userId: "other" });
      if (mode === "provider")
        f.getSubscriber.mockResolvedValue({
          id: 999,
          email_address: "student@example.com",
          state: "active",
          fields: { pref_newsletter: "subscribed" },
        });
      if (mode === "missing-state") rows.states = [];
      f.repository.readIdentity = async () => rows;
      expect(Either.isLeft(await run(f.authority))).toBe(true);
    },
  );
  it("allows a provider-confirmed contact without inventing a verified User", async () => {
    const f = fixture();
    const rows = await f.repository.readIdentity(contactId);
    rows.contact!.userId = null;
    rows.users = [];
    f.repository.readIdentity = async () => rows;
    expect(Either.isRight(await run(f.authority))).toBe(true);
    expect(f.repository.readPurchases).not.toHaveBeenCalled();
  });
  it.each(["identity", "purchase", "provider"])(
    "returns redacted unavailable for %s storage/provider failures",
    async (source) => {
      const f = fixture();
      const fail = async (): Promise<never> => {
        throw new Error("private provider payload");
      };
      if (source === "identity") f.repository.readIdentity = fail;
      if (source === "purchase") f.repository.readPurchases = fail;
      if (source === "provider") f.getSubscriber.mockImplementation(fail);
      const result = await run(f.authority);
      expect(Either.isLeft(result) && result.left.type).toBe(
        "AuthorityUnavailable",
      );
      expect(JSON.stringify(result)).not.toContain("private provider payload");
    },
  );
  it("does not fabricate purchase facts for manual grants or mismatched products", async () => {
    for (const override of [
      { productId: "other-product" },
      {
        via: "entitlement" as const,
        sourceType: "MANUAL",
        entitlementId: "grant",
      },
      { beneficiaryUserId: "other-user" },
      { id: null },
      { effectiveProductId: null },
      { status: "Refunded" },
    ]) {
      const f = fixture();
      f.repository.readPurchases = async () => [
        {
          id: "purchase-test",
          productId: "product-ma254",
          userId: "user-test",
          status: "Valid",
          createdAt: at,
          via: "direct",
          beneficiaryUserId: "user-test",
          effectiveProductId: "product-ma254",
          ...override,
        },
      ];
      expect(Either.isLeft(await run(f.authority))).toBe(true);
    }
  });
  it("accepts source-purchase-backed team fulfillment without calling the recipient the buyer", async () => {
    const f = fixture();
    f.repository.readPurchases = async () => [
      {
        id: "team-purchase",
        productId: "source-bundle",
        userId: "team-buyer",
        status: "Restricted",
        createdAt: at,
        via: "entitlement",
        beneficiaryUserId: "user-test",
        effectiveProductId: "product-ma254",
        sourceType: "PURCHASE",
        entitlementId: "team-entitlement",
      },
    ];
    const result = await run(f.authority);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result))
      expect(result.right.purchase).toMatchObject({
        purchaseId: "team-purchase",
        sourceProductId: "source-bundle",
      });
  });
  it("fails closed for missing canonical facts, unknown heads, and the wrong supplied journey", async () => {
    const f = fixture();
    f.repository.readExhaustionFacts = async () => [];
    expect(Either.isLeft(await run(f.authority))).toBe(true);
    f.repository.readExhaustionFacts = async () => [exhaustion()];
    f.repository.readJourneyHeads = async () => [
      { journeyId: "unknown", actorVersion: 1, snapshot: {} },
    ];
    expect(Either.isLeft(await run(f.authority))).toBe(true);
  });
  it("finds a journey on the other path using canonical indexed source IDs", async () => {
    const f = fixture();
    const first = await run(f.authority);
    if (Either.isLeft(first)) throw new Error(first.left.type);
    const source = exhaustion("ai-hero-skills-team-workflow");
    const payload = restoreCourseSequenceExhaustedPayload(
      readCoursePayload(source.payloadSummary)?.payload,
    );
    const entryFactId = parseEntryFactId(source.id),
      stimulusId = parseStimulusId(source.id),
      now = parseIsoInstant(at.toISOString());
    if (!payload || !entryFactId.ok || !stimulusId.ok || !now.ok)
      throw new Error("Bad source fixture");
    const decision = decideEvergreenOfferJourney({
      snapshot: null,
      stimulus: {
        type: "CourseSequenceExhausted",
        entryFactId: entryFactId.value,
        stimulusId: stimulusId.value,
        contactId,
        valuePathId: payload.actor.valuePathId,
        exhaustedAt: payload.exhaustedAt,
        deadlineTimeZone: payload.deadlineTimeZone,
        sourceReference: "side-effect-intent:six",
      },
      currentFacts: first.right,
      definition: EVERGREEN_OFFER_JOURNEY_V1,
      now: now.value,
    });
    if (!decision.ok || decision.decision.type !== "Accepted")
      throw new Error("Bad head fixture");
    const aggregate = decision.decision.next;
    f.repository.readExhaustionFacts = async () => [exhaustion(), source];
    f.repository.readJourneyHeads = vi.fn(async () => [
      {
        journeyId: aggregate.journeyId,
        actorVersion: aggregate.version,
        snapshot: aggregate,
      },
    ]);
    const second = await run(f.authority);
    if (Either.isLeft(second)) throw new Error(second.left.type);
    expect(second.right.existingJourneyId).toBe(aggregate.journeyId);
    expect(f.repository.readJourneyHeads).toHaveBeenCalledWith([
      `evergreen-offer:${exhaustion().id}`,
      `evergreen-offer:${source.id}`,
    ]);
    const same = await Effect.runPromise(
      Effect.either(
        f.authority.currentFacts({ contactId, journeyId: aggregate.journeyId }),
      ),
    );
    expect(Either.isRight(same)).toBe(true);
    const wrongId = parseJourneyId("evergreen-offer:wrong-source");
    if (!wrongId.ok) throw new Error("bad fixture");
    const wrong = await Effect.runPromise(
      Effect.either(
        f.authority.currentFacts({ contactId, journeyId: wrongId.value }),
      ),
    );
    expect(Either.isLeft(wrong) && wrong.left.type).toBe(
      "AuthorityInconsistent",
    );
    f.repository.readJourneyHeads = async () => [
      {
        journeyId: aggregate.journeyId,
        actorVersion: aggregate.version,
        snapshot: aggregate,
      },
      {
        journeyId: aggregate.journeyId,
        actorVersion: aggregate.version,
        snapshot: aggregate,
      },
    ];
    expect(Either.isLeft(await run(f.authority))).toBe(true);
  });
  it.each([undefined, null, "", "  "])(
    "uses the documented newsletter default for active subscriber preference %s",
    async (value) => {
      const f = fixture();
      f.getSubscriber.mockResolvedValue({
        id: 123,
        email_address: "student@example.com",
        state: "active",
        fields: value === undefined ? {} : { pref_newsletter: value },
      });
      const result = await run(f.authority);
      expect(Either.isRight(result) && result.right.delivery.type).toBe(
        "Eligible",
      );
    },
  );
  it("denies absent preference when the injected app definition defaults false", async () => {
    const f = fixture({ field: "pref_newsletter", defaultSubscribed: false });
    f.getSubscriber.mockResolvedValue({
      id: 123,
      email_address: "student@example.com",
      state: "active",
    });
    const result = await run(f.authority);
    expect(Either.isRight(result) && result.right.delivery.type).toBe(
      "Unsubscribed",
    );
  });
  it.each([
    undefined,
    {},
    { field: "pref_newsletter" },
    { field: "pref_newsletter", defaultSubscribed: "true" },
    { field: "", defaultSubscribed: true },
    { field: " pref_newsletter", defaultSubscribed: true },
  ])("holds malformed preference definition %j", async (value) => {
    const f = fixture();
    const communication = createKitCurrentCommunicationReader({
      getSubscriber: f.getSubscriber,
      now: () => at,
      preference: value as Preference,
    });
    await expect(
      communication.read({ subscriberId: "123", email: "student@example.com" }),
    ).rejects.toThrow();
  });
  it.each([
    {},
    { state: "unknown" },
    { state: "inactive" },
    { state: "active", fields: { pref_newsletter: "maybe" } },
  ])("does not default unresolved provider evidence %j", async (override) => {
    const f = fixture();
    f.getSubscriber.mockResolvedValue({
      id: 123,
      email_address: "student@example.com",
      ...override,
    });
    expect(Either.isLeft(await run(f.authority))).toBe(true);
  });
  it.each(["envelope", "mixed"])(
    "rejects the unsupported %s subscriber input contract",
    async (mode) => {
      const f = fixture();
      const raw = {
        id: 123,
        email_address: "student@example.com",
        state: "active",
        fields: { pref_newsletter: "subscribed" },
      };
      f.getSubscriber.mockResolvedValue(
        mode === "envelope"
          ? { subscriber: raw }
          : { ...raw, subscriber: { ...raw, id: 999 } },
      );
      expect(Either.isLeft(await run(f.authority))).toBe(true);
    },
  );
  it.each(["2026-09-07T18:59:59.000Z", "2026-09-07T19:00:01.000Z"])(
    "rejects stale/future communication readAt %s",
    async (readAt) => {
      const f = fixture();
      const read = f.communication.read;
      f.communication.read = async (identity) => ({
        ...(await read(identity)),
        readAt,
      });
      const result = await run(f.authority);
      expect(Either.isLeft(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("student@example.com");
    },
  );
  it("rejects an exact supplied journey ID absent from canonical heads", async () => {
    const f = fixture(),
      journeyId = parseJourneyId("evergreen-offer:other");
    if (!journeyId.ok) throw new Error("bad fixture");
    const result = await Effect.runPromise(
      Effect.either(
        f.authority.currentFacts({ contactId, journeyId: journeyId.value }),
      ),
    );
    expect(Either.isLeft(result) && result.left.type).toBe(
      "AuthorityInconsistent",
    );
  });
  it("does not ignore unsupported provider suppression evidence", async () => {
    const f = fixture();
    f.getSubscriber.mockResolvedValue({
      id: 123,
      email_address: "student@example.com",
      state: "active",
      fields: { pref_newsletter: "subscribed" },
      suppressed: true,
    });
    expect(Either.isLeft(await run(f.authority))).toBe(true);
  });
});
