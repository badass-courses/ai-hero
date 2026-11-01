import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Surveys with Kit unreachable: every Kit host refuses, and the Kit provider
 * throws on any use. Answers must still be stored locally and handed to the
 * drovr interest-fact hook, with no Kit subscribe and no Kit field write.
 */

const dialect = new MySqlDialect();

const mocks = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  identities: new Map<string, string>(),
  contacts: new Map<string, { email: string | null; name: string | null }>(),
  kitCalls: [] as string[],
  kitUp: false,
  kitFetches: [] as string[],
  inserted: [] as Array<Record<string, unknown>>,
  insertFails: false,
  scheduled: [] as Array<{ questionId: string; email: string | null }>,
}));

function whereParams(args: unknown): unknown[] {
  const where = (args as { where?: unknown })?.where;
  return dialect.sqlToQuery(where as never).params;
}

vi.mock("@/db", () => ({
  db: {
    query: {
      providerIdentity: {
        findFirst: async (args: unknown) => {
          const [provider, externalId] = whereParams(args);
          if (provider !== "kit") return undefined;
          const contactId = mocks.identities.get(String(externalId));
          return contactId ? { contactId } : undefined;
        },
      },
      contact: {
        findFirst: async (args: unknown) => {
          const [id] = whereParams(args);
          return mocks.contacts.get(String(id));
        },
      },
      users: { findFirst: async () => undefined },
      contentResource: {
        findFirst: async () => ({ id: "survey-1" }),
        findMany: async () => [
          { id: "question-goal", fields: { slug: "goal" } },
          { id: "question-level", fields: { slug: "level" } },
        ],
      },
    },
    insert: () => ({
      values: async (rows: Array<Record<string, unknown>>) => {
        if (mocks.insertFails) throw new Error("database unavailable");
        mocks.inserted.push(...rows);
      },
    }),
  },
}));

vi.mock("@/coursebuilder/email-list-provider", () => ({
  emailListProvider: new Proxy(
    {},
    {
      get: (_target, property) => () => {
        mocks.kitCalls.push(String(property));
        if (!mocks.kitUp) throw new Error("Kit is unreachable");
        return {
          id: 1234567,
          email_address: "reader@example.test",
          state: "active",
          fields: {},
        };
      },
    },
  ),
}));

vi.mock("@/lib/subscriber-marketing/survey-interest-facts-live", () => ({
  scheduleGoalInterestFact: (row: {
    questionId: string;
    email: string | null;
  }) => {
    mocks.scheduled.push({ questionId: row.questionId, email: row.email });
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mocks.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/convertkit", () => ({ getSubscriberFromCookie: vi.fn() }));
vi.mock("@/server/auth", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/server/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { convertkitRouter } from "./convertkit";

const KIT_ID = "1234567";

function caller() {
  return convertkitRouter.createCaller({
    db: null,
    session: null,
    ability: null,
    headers: new Headers(),
  } as any);
}

describe("surveys off Kit, with Kit unreachable", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    mocks.cookies.clear();
    mocks.identities.clear();
    mocks.contacts.clear();
    mocks.kitCalls.length = 0;
    mocks.kitUp = false;
    mocks.kitFetches.length = 0;
    mocks.inserted.length = 0;
    mocks.insertFails = false;
    mocks.scheduled.length = 0;
    mocks.identities.set(KIT_ID, "contact-1");
    mocks.contacts.set("contact-1", {
      email: "reader@example.test",
      name: "Reader",
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      mocks.kitFetches.push(url);
      throw new TypeError(`fetch failed: ${url} refused`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  it("keeps owned answers and drovr facts, with zero Kit calls", async () => {
    const result = await caller().answerSurveyMultiple({
      surveyId: "ai-coding-readiness",
      email: "anon@example.test",
      answers: { goal: "ship-faster" },
    });
    expect(result).toMatchObject({ success: true, storedInDb: true });
    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.scheduled).toEqual([
      { questionId: "question-goal", email: "anon@example.test" },
    ]);
    expect(mocks.kitCalls).toEqual([]);
    expect(mocks.kitFetches).toEqual([]);
  });

  it("stores an anonymous emailed answer set locally and subscribes no one", async () => {
    const result = await caller().answerSurveyMultiple({
      surveyId: "ai-coding-readiness",
      email: "anon@example.test",
      answers: { goal: "ship-faster", level: ["new", "curious"] },
    });

    expect(result).toEqual({
      success: true,
      storedInDb: true,
      subscriberSyncError: null,
    });
    // No subscriber id comes back, so the client sets no Kit cookie.
    expect(result).not.toHaveProperty("id");
    expect(mocks.inserted).toEqual([
      expect.objectContaining({
        surveyId: "survey-1",
        questionId: "question-goal",
        emailListSubscriberId: null,
        fields: { answer: "ship-faster" },
      }),
      expect.objectContaining({
        questionId: "question-level",
        fields: { answer: "new, curious" },
      }),
    ]);
    expect(mocks.scheduled).toEqual([
      { questionId: "question-goal", email: "anon@example.test" },
      { questionId: "question-level", email: "anon@example.test" },
    ]);
    expect(mocks.kitCalls).toEqual([]);
    expect(mocks.kitFetches).toEqual([]);
  });

  it("names a broadcast-link answerer through the directory, not Kit", async () => {
    mocks.cookies.set("ck_subscriber_id", `"${KIT_ID}"`);

    const result = await caller().answerSurvey({
      surveyId: "ai-coding-readiness",
      question: "goal",
      answer: "ship-faster",
    });

    expect(result).toEqual({
      success: true,
      storedInDb: true,
      subscriberLookupError: null,
    });
    expect(mocks.inserted).toEqual([
      expect.objectContaining({
        questionId: "question-goal",
        emailListSubscriberId: KIT_ID,
        fields: { answer: "ship-faster" },
      }),
    ]);
    expect(mocks.scheduled).toEqual([
      { questionId: "question-goal", email: "reader@example.test" },
    ]);
    expect(mocks.kitCalls).toEqual([]);
    expect(mocks.kitFetches).toEqual([]);
  });

  it("completes a known answerer without a Kit field write", async () => {
    mocks.cookies.set("ck_subscriber_id", KIT_ID);

    await expect(
      caller().answerSurveyMultiple({
        surveyId: "ai-coding-readiness",
        email: "reader@example.test",
        answers: {},
      }),
    ).resolves.toEqual({
      success: true,
      storedInDb: true,
      subscriberSyncError: null,
    });
    expect(mocks.kitCalls).toEqual([]);
    expect(mocks.kitFetches).toEqual([]);
  });

  it("answers anonymously for an id the directory does not know", async () => {
    mocks.cookies.set("ck_subscriber_id", "7654321");

    await caller().answerSurvey({
      surveyId: "ai-coding-readiness",
      question: "goal",
      answer: "ship-faster",
    });

    expect(mocks.inserted).toEqual([
      expect.objectContaining({ emailListSubscriberId: null }),
    ]);
    expect(mocks.scheduled).toEqual([
      { questionId: "question-goal", email: null },
    ]);
    expect(mocks.kitCalls).toEqual([]);
  });

  it("reports a failed save of an answer set instead of success", async () => {
    mocks.insertFails = true;
    mocks.cookies.set("ck_subscriber_id", KIT_ID);

    const result = await caller().answerSurveyMultiple({
      surveyId: "ai-coding-readiness",
      email: "reader@example.test",
      answers: { goal: "ship-faster" },
    });

    expect(result).toEqual({
      success: false,
      storedInDb: false,
      subscriberSyncError: null,
    });
    expect(mocks.inserted).toEqual([]);
    expect(mocks.scheduled).toEqual([]);
    expect(mocks.kitCalls).toEqual([]);
    expect(mocks.kitFetches).toEqual([]);
  });

  it("reports a failed save of a single answer instead of success", async () => {
    mocks.insertFails = true;
    mocks.cookies.set("ck_subscriber_id", KIT_ID);

    const result = await caller().answerSurvey({
      surveyId: "ai-coding-readiness",
      question: "goal",
      answer: "ship-faster",
    });

    expect(result).toEqual({
      success: false,
      storedInDb: false,
      subscriberLookupError: null,
    });
    expect(mocks.inserted).toEqual([]);
    expect(mocks.scheduled).toEqual([]);
    expect(mocks.kitCalls).toEqual([]);
    expect(mocks.kitFetches).toEqual([]);
  });
});
