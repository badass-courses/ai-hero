import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DrovrExecutorRepository,
  DrovrIntent,
} from "@/lib/subscriber-marketing/drovr-executor";
import type {
  ContactRecord,
  ContactState,
  SideEffectIntent,
} from "@/lib/subscriber-marketing/types";
import type { ValuePathEmailExecutorConfig } from "@/lib/subscriber-marketing/value-path-email-executor";

// Real POST -> real acceptDrovrIntent (including its private acceptance branches)
// -> real value-path executor for sync sends. Only persistence, configuration,
// scheduling and outward transports are replaced. These are software guards,
// not an OS sandbox or evidence about historical sends.
const boundary = vi.hoisted(() => ({
  repository: undefined as DrovrExecutorRepository | undefined,
  sync: false,
  after: vi.fn<[callback: () => Promise<void>], void>(),
  provider: vi.fn(),
  dispatch: vi.fn(),
  formSubscribe: vi.fn(),
  unsubscribe: vi.fn(),
  profileSync: vi.fn(),
  observeDelivery: vi.fn(),
  budgetTake: vi.fn(),
  budgetRefund: vi.fn(),
  identityReads: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/server", async () => ({
  ...(await vi.importActual<typeof import("next/server")>("next/server")),
  after: boundary.after,
}));
vi.mock("@/env.mjs", () => ({
  env: { DROVR_EXECUTOR_TOKEN: "local-contract-token" },
}));
vi.mock("@/db", () => ({
  db: {
    select: () => {
      boundary.identityReads();
      return {
        from: () => ({
          where: () => ({
            limit: async () => [
              { id: "contract-identity", externalId: "contract-kit-id" },
            ],
          }),
        }),
      };
    },
  },
}));
vi.mock("@/db/schema", () => ({
  providerIdentity: {
    id: "id",
    contactId: "contactId",
    provider: "provider",
    externalId: "externalId",
  },
}));
vi.mock("@/lib/subscriber-marketing/drizzle-capture-repository", () => ({
  DrizzleCaptureMarketingRepository: vi.fn(() => {
    if (!boundary.repository)
      throw new Error("synthetic repository not installed");
    return boundary.repository;
  }),
}));
vi.mock("@/server/with-skill", () => ({
  withSkill: (handler: (request: NextRequest) => Promise<Response>) => handler,
}));
vi.mock("@/server/logger", () => ({ log: boundary.log }));
vi.mock("@/server/redis-client", () => ({ redis: {} }));
vi.mock("@/coursebuilder/email-list-provider", () => ({
  emailListProvider: { subscribeToList: boundary.provider },
}));
vi.mock("@/lib/subscriber-marketing/drovr-shadow-dispatch", () => ({
  dispatchDrovrShadowFactSafely: boundary.dispatch,
}));
vi.mock("@/lib/subscriber-marketing/drovr-contact-profile-sync", () => ({
  requestContactProfileSync: boundary.profileSync,
}));
vi.mock("@/lib/subscriber-marketing/email-course-shadow-runtime", () => ({
  createEmailCourseShadowRuntime: () => ({
    observeDelivery: boundary.observeDelivery,
  }),
}));
vi.mock(
  "@/lib/subscriber-marketing/drizzle-value-path-link-anchor",
  async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/subscriber-marketing/value-path-link-anchor")
    >("@/lib/subscriber-marketing/value-path-link-anchor");
    return {
      createDrizzleValuePathLinkAnchorStore:
        actual.createMemoryValuePathLinkAnchorStore,
    };
  },
);
vi.mock("@/lib/subscriber-marketing/value-path-answer-page", () => ({
  getValuePathAnswerPages: async () => [],
}));
vi.mock("@/lib/subscriber-marketing/value-path-gate-d-allowlist", async () => ({
  ...(await vi.importActual<
    typeof import("@/lib/subscriber-marketing/value-path-gate-d-allowlist")
  >("@/lib/subscriber-marketing/value-path-gate-d-allowlist")),
  readActiveGateDRuntimeAllowlist: async () => ({
    passed: true,
    allowlist: {},
  }),
}));
vi.mock("@/lib/subscriber-marketing/value-path-executor-config", () => ({
  buildValuePathExecutorConfig: (): ValuePathEmailExecutorConfig => ({
    mode: "scoped-live",
    allowWrite: true, // Writes only to the injected in-memory repository.
    allowlistedContactIds: ["contract-contact"],
    allowlistedKitSubscriberIds: ["contract-kit-id"],
    allowlistedEmails: ["contract@synthetic.aihero.invalid"],
    enabledValuePathSlugs: ["ai-hero-skills-workflow"],
    verifiedEmailResourceIds: ["ai-hero-skills-workflow.email-6"],
    verifiedKitSequenceIds: ["2757205"],
    allowedActions: ["send-path-emails"],
    providerPacingMs: 0,
  }),
}));
vi.mock("@/lib/subscriber-marketing/drovr-sync-send", async () => ({
  ...(await vi.importActual<
    typeof import("@/lib/subscriber-marketing/drovr-sync-send")
  >("@/lib/subscriber-marketing/drovr-sync-send")),
  parseDrovrSyncSendConfig: () =>
    boundary.sync
      ? { enabled: true, perMinute: 60 }
      : { enabled: false, reason: "synthetic queued scenario" },
  drovrSendDeadlineMs: () => 10_000,
  drovrSendBudget: () => ({
    take: boundary.budgetTake,
    refund: boundary.budgetRefund,
  }),
}));
vi.mock("@/lib/subscriber-marketing/drovr-evergreen", async () => ({
  ...(await vi.importActual<
    typeof import("@/lib/subscriber-marketing/drovr-evergreen")
  >("@/lib/subscriber-marketing/drovr-evergreen")),
  parseDrovrEvergreenConfig: () => ({ enabled: true }),
}));
vi.mock("@/lib/subscriber-marketing/drovr-list-subscribe", async () => ({
  ...(await vi.importActual<
    typeof import("@/lib/subscriber-marketing/drovr-list-subscribe")
  >("@/lib/subscriber-marketing/drovr-list-subscribe")),
  createKitFormSubscriber: () => boundary.formSubscribe,
}));
vi.mock("@/lib/subscriber-marketing/drovr-list-unsubscribe", async () => ({
  ...(await vi.importActual<
    typeof import("@/lib/subscriber-marketing/drovr-list-unsubscribe")
  >("@/lib/subscriber-marketing/drovr-list-unsubscribe")),
  createKitUnsubscriber: () => boundary.unsubscribe,
}));

import { SHADOW_NEWSLETTER_CATALOG_REVISION } from "@/lib/subscriber-marketing/drovr-shadow-newsletter";
import {
  EVERGREEN_OFFER_PRODUCT_ID,
  EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
  EVERGREEN_OFFER_MAX_USES,
} from "@/lib/subscriber-marketing/evergreen-offer-journey/domain";
import { POST } from "./route";

const NOW = "2026-10-08T17:00:00.000Z";
const EMAIL = "contract@synthetic.aihero.invalid";

class MemoryRepository implements DrovrExecutorRepository {
  readonly intents = new Map<string, SideEffectIntent>();
  creates = 0;
  claims = 0;
  writes = 0;
  race = false;

  findContactById(id: string): ContactRecord | undefined {
    if (id !== "contract-contact") return undefined;
    // A local fake needs a non-synthetic_-prefixed id to reach acceptance;
    // no principal is created anywhere. Its address is undeliverable.
    return {
      id,
      email: EMAIL,
      name: "Contract Fixture",
      lifecycle: "nurture-ready",
      isProvisional: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }
  findCurrentContactState(contactId: string): ContactState {
    return {
      id: "contract-state",
      contactId,
      lifecycle: "nurture-ready",
      primaryBucket: "other-unclear",
      allBuckets: [],
      whySignals: [],
      whoSignals: [],
      confidence: 1,
      rationale: [],
      reviewSignals: [],
      humanReview: false,
      lastEventId: "contract-event",
      schemaVersion: 1,
      updatedAt: NOW,
    };
  }
  findContactEventsByType() {
    return [];
  }
  findPendingValuePathEmailSideEffectIntents() {
    return [...this.intents.values()].filter((row) => row.status === "pending");
  }
  findValuePathEmailSideEffectIntentsByContact(contactId: string) {
    return [...this.intents.values()].filter(
      (row) =>
        row.contactId === contactId && row.type === "send-value-path-email",
    );
  }
  findSideEffectIntentByIdempotencyKey(key: string) {
    return [...this.intents.values()].find((row) => row.idempotencyKey === key);
  }
  createSideEffectIntent(input: SideEffectIntent) {
    this.creates++;
    if (this.race) {
      // Emulate a unique-key winner becoming visible between read and insert.
      this.race = false;
      this.intents.set("contract-race-winner", {
        ...input,
        id: "contract-race-winner",
      });
      throw new Error("synthetic unique-key collision");
    }
    if (this.findSideEffectIntentByIdempotencyKey(input.idempotencyKey)) {
      throw new Error("synthetic unique-key collision");
    }
    this.intents.set(input.id, input);
    return input;
  }
  row() {
    expect(this.intents.size).toBe(1);
    const row = this.intents.values().next().value;
    if (!row) throw new Error("expected one durable synthetic intent");
    return row;
  }
  updateSideEffectIntent(
    id: string,
    patch: Pick<
      SideEffectIntent,
      "status" | "gates" | "reviewReasons" | "metadata" | "completedAt"
    >,
  ) {
    const row = this.intents.get(id);
    if (!row) throw new Error("missing synthetic intent");
    this.writes++;
    const next = { ...row, ...patch };
    this.intents.set(id, next);
    return next;
  }
  claimSideEffectIntentForSend(
    id: string,
    args: { now: string; staleAfterMs: number },
  ) {
    const row = this.intents.get(id);
    if (!row || row.status !== "pending") return false;
    this.claims++;
    this.intents.set(id, {
      ...row,
      status: "sending",
      metadata: { ...row.metadata, claimedAt: args.now },
    });
    return true;
  }
}

const coupon = {
  productId: EVERGREEN_OFFER_PRODUCT_ID,
  amountOffCents: EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
  maxUses: EVERGREEN_OFFER_MAX_USES,
  exclusive: true,
  regularPriceCents: 29_900,
  effectivePriceCents: 19_900,
  issueAt: NOW,
  expiresAt: "2026-10-13T06:59:59.000Z",
  timezone: "America/Los_Angeles",
  timezoneSource: "vercel-header",
};
const cases = [
  {
    name: "generic email.send",
    journeyId: "value-path-skills-course",
    kind: "email.send",
    payload: { emailResourceId: "ai-hero-skills-workflow.email-6" },
    key: "contact:contract-contact:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-6",
    type: "send-value-path-email",
    completion: "email.completed",
    identityReads: 1,
  },
  {
    name: "shadow newsletter",
    journeyId: "shadow-newsletter",
    kind: "email.send",
    payload: {
      newsletter: "shadow-newsletter",
      catalogRevision: SHADOW_NEWSLETTER_CATALOG_REVISION,
      messageId: "agents_md_big_problem_v1",
    },
    key: "contact:org-aihero:contract-contact:shadow-newsletter:agents_md_big_problem_v1",
    type: "send-shadow-newsletter-email",
    completion: "email.completed",
    identityReads: 1,
  },
  {
    name: "coupon.issue",
    journeyId: "crash-course-evergreen-offer",
    kind: "coupon.issue",
    payload: coupon,
    key: "contact:contract-contact:evergreen:coupon",
    type: "issue-evergreen-coupon",
    completion: "coupon.issued",
    identityReads: 1,
  },
  {
    name: "list.subscribe",
    journeyId: "crash-course-evergreen-offer",
    kind: "list.subscribe",
    payload: { list: "shadow-newsletter" },
    key: "contact:contract-contact:evergreen:list:shadow-newsletter",
    type: "subscribe-evergreen-list",
    completion: "shadow.entered",
    identityReads: 0,
  },
] satisfies Array<{
  name: string;
  journeyId: string;
  kind: string;
  payload: Record<string, unknown>;
  key: string;
  type: string;
  completion: string;
  identityReads: number;
}>;

type Scenario = (typeof cases)[number];
const requestFor = (scenario: Scenario): DrovrIntent => ({
  tenantId: "org-aihero",
  contactId: "contract-contact",
  journeyId: scenario.journeyId,
  kind: scenario.kind,
  idempotencyKey: `contract-transition:${scenario.name}`,
  dueAt: NOW,
  payload: scenario.payload,
});
const post = (intent: DrovrIntent) =>
  POST(
    new NextRequest("https://contract.invalid/api/drovr/intents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local-contract-token",
      },
      body: JSON.stringify(intent),
    }),
  );
const counts = (repository: MemoryRepository) => ({
  rows: repository.intents.size,
  creates: repository.creates,
  claims: repository.claims,
  writes: repository.writes,
  provider: boundary.provider.mock.calls.length,
  formSubscribe: boundary.formSubscribe.mock.calls.length,
  unsubscribe: boundary.unsubscribe.mock.calls.length,
  dispatch: boundary.dispatch.mock.calls.length,
  after: boundary.after.mock.calls.length,
  profileSync: boundary.profileSync.mock.calls.length,
  observer: boundary.observeDelivery.mock.calls.length,
  budget: boundary.budgetTake.mock.calls.length,
  refund: boundary.budgetRefund.mock.calls.length,
  identityReads: boundary.identityReads.mock.calls.length,
});
const accepted = (row: SideEffectIntent, created: boolean) => ({
  status: "accepted",
  intentId: row.id,
  idempotencyKey: row.idempotencyKey,
  created,
});

let repository: MemoryRepository;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("real HTTP forbidden in dedupe contract");
    }),
  );
  repository = new MemoryRepository();
  boundary.repository = repository;
  boundary.sync = false;
  for (const transport of [
    boundary.provider,
    boundary.formSubscribe,
    boundary.unsubscribe,
    boundary.profileSync,
    boundary.observeDelivery,
  ]) {
    transport.mockReset().mockImplementation(() => {
      throw new Error("unexpected synthetic transport");
    });
  }
  boundary.dispatch.mockReset().mockImplementation(() => {
    throw new Error("unexpected dispatch");
  });
  boundary.budgetTake
    .mockReset()
    .mockResolvedValue({ ok: true, retryAfterMs: 0 });
  boundary.budgetRefund.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  boundary.repository = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("same-key re-ask through the real POST and executor", () => {
  it.each(cases)(
    "$name: interrupted acceptance has one row and zero second-call effects",
    async (scenario) => {
      const intent = requestFor(scenario);
      // The client discards this response (timeout after durable acceptance).
      const first = await post(intent);
      const row = repository.row();
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual(accepted(row, true));
      expect(row).toMatchObject({
        status: "pending",
        idempotencyKey: scenario.key,
        type: scenario.type,
        metadata: { drovr: { intentKey: intent.idempotencyKey } },
      });
      const firstCounts = counts(repository);
      expect(firstCounts).toEqual({
        rows: 1,
        creates: 1,
        claims: 0,
        writes: 0,
        provider: 0,
        formSubscribe: 0,
        unsubscribe: 0,
        dispatch: 0,
        after: 0,
        profileSync: 0,
        observer: 0,
        budget: 0,
        refund: 0,
        identityReads: scenario.identityReads,
      });
      const stored = structuredClone(row);
      const second = await post(intent);
      expect(second.status).toBe(202);
      expect(await second.json()).toEqual(accepted(row, false));
      expect(repository.row()).toEqual(stored);
      expect(counts(repository)).toEqual(firstCounts);
    },
  );

  it.each(cases)(
    "$name: completed and definite failed answers evolve truthfully, without replay work",
    async (scenario) => {
      const intent = requestFor(scenario);
      expect((await post(intent)).status).toBe(202);
      const row = repository.row();
      // Synthetic completion, not a sender invocation or live-delivery claim.
      repository.updateSideEffectIntent(row.id, {
        status: "completed",
        completedAt: NOW,
        gates: [],
        reviewReasons: [],
        metadata: {
          ...row.metadata,
          ...(scenario.kind === "coupon.issue"
            ? { couponId: "contract-coupon", expiresAt: coupon.expiresAt }
            : {}),
        },
      });
      const completedCounts = counts(repository);
      const completed = await post(intent);
      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({
        status: "completed",
        intentId: row.id,
        completion: {
          type: scenario.completion,
          idempotencyKey: `completion:${intent.idempotencyKey}`,
          occurredAt: NOW,
          contactId: intent.contactId,
          tenantId: intent.tenantId,
        },
      });
      expect(counts(repository)).toEqual(completedCounts);
      repository.updateSideEffectIntent(row.id, {
        status: "failed",
        completedAt: null,
        gates: [],
        reviewReasons: ["kit-400"],
        metadata: { ...row.metadata, retryable: false },
      });
      const failedCounts = counts(repository);
      const failed = await post(intent);
      expect(failed.status).toBe(200);
      expect(await failed.json()).toEqual({
        status: "failed",
        intentId: row.id,
        reasonClass: "kit-400",
        reason: "kit-400",
      });
      expect(counts(repository)).toEqual(failedCounts);
    },
  );

  it("shadow newsletter: an insertion race retains the winning transition owner", async () => {
    const scenario = cases[1]!;
    const intent = requestFor(scenario);
    repository.race = true;
    const first = await post(intent);
    const row = repository.row();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual(accepted(row, false));
    expect(row.id).toBe("contract-race-winner");
    expect(row.idempotencyKey).toBe(scenario.key);
    expect(row.metadata.drovr).toMatchObject({
      intentKey: intent.idempotencyKey,
    });
    const firstCounts = counts(repository);
    expect(firstCounts).toMatchObject({
      creates: 1,
      rows: 1,
      provider: 0,
      dispatch: 0,
      after: 0,
    });
    const second = await post(intent);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(accepted(row, false));
    expect(counts(repository)).toEqual(firstCounts);
    // A new transition with the same semantic message must not steal ownership.
    repository.updateSideEffectIntent(row.id, {
      status: "completed",
      completedAt: NOW,
      gates: [],
      reviewReasons: [],
      metadata: row.metadata,
    });
    const completedCounts = counts(repository);
    const redrive = await post({
      ...intent,
      idempotencyKey: "contract-other-transition",
    });
    expect(redrive.status).toBe(200);
    expect(await redrive.json()).toMatchObject({
      status: "completed",
      completion: { idempotencyKey: `completion:${intent.idempotencyKey}` },
    });
    expect(repository.row().metadata.drovr).toEqual(row.metadata.drovr);
    expect(counts(repository)).toEqual(completedCounts);
  });

  it("sync send: 202 plus after() keeps the first claim; immediate re-ask does not send or schedule again", async () => {
    boundary.sync = true;
    let finishProvider: (() => void) | undefined;
    const providerGate = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    boundary.provider.mockImplementation(async () => {
      await providerGate;
      return { subscriber: { id: "contract-kit-id" } };
    });
    boundary.dispatch.mockImplementation(() => undefined);
    const intent = requestFor(cases[0]!);
    const firstPending = post(intent);
    // Deterministically cross the actual 10s response deadline; no real sleep.
    await vi.advanceTimersByTimeAsync(10_000);
    const first = await firstPending;
    const row = repository.row();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual(accepted(row, true));
    expect(row.status).toBe("sending");
    expect(boundary.provider).toHaveBeenCalledWith(
      expect.objectContaining({
        listId: "2757205",
        listType: "sequence",
        user: expect.objectContaining({ email: EMAIL }),
      }),
    );
    const firstCounts = counts(repository);
    expect(firstCounts).toEqual({
      rows: 1,
      creates: 1,
      claims: 1,
      writes: 0,
      provider: 1,
      formSubscribe: 0,
      unsubscribe: 0,
      dispatch: 0,
      after: 1,
      profileSync: 0,
      observer: 0,
      budget: 1,
      refund: 0,
      identityReads: 1,
    });
    const owned = structuredClone(row);
    const second = await post(intent);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(accepted(row, false));
    expect(repository.row()).toEqual(owned);
    expect(counts(repository)).toEqual(firstCounts);

    const callback = boundary.after.mock.calls[0]?.[0];
    if (!callback || !finishProvider)
      throw new Error("first continuation/provider not captured");
    const background = callback();
    // after() waits for an already-started send; it does not initiate Kit work.
    finishProvider();
    await background;
    expect(repository.row()).toMatchObject({ id: row.id, status: "completed" });
    expect(repository.row().metadata.drovr).toEqual(owned.metadata.drovr);
    expect(boundary.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "side-effect-intent-completed",
        intent: expect.objectContaining({ id: row.id, status: "completed" }),
      }),
    );
    expect(boundary.log.info).toHaveBeenCalledWith(
      "drovr.executor.sync_send_settled",
      expect.objectContaining({
        intentId: row.id,
        status: "completed",
        durationMs: 10_000,
      }),
    );
    const settledCounts = { ...firstCounts, writes: 1, dispatch: 1 };
    expect(counts(repository)).toEqual(settledCounts);
    const completed = await post(intent);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      status: "completed",
      intentId: row.id,
      completion: { idempotencyKey: `completion:${intent.idempotencyKey}` },
    });
    expect(counts(repository)).toEqual(settledCounts);
  });
});
