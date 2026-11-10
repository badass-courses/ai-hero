import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cookie identity with Kit unreachable: every Kit host refuses, and the Kit
 * provider throws on any use. Broadcast-link and partial cookies must still
 * name the reader, through the contact directory alone.
 */

const dialect = new MySqlDialect();

const mocks = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  written: new Map<string, string>(),
  identities: new Map<string, string>(),
  contacts: new Map<string, { email: string | null; name: string | null }>(),
  directoryDown: false,
  directoryReads: 0,
  kitCalls: [] as string[],
  session: null as null | { user: { id: string; email: string } },
  usersByEmail: new Map<string, string>(),
  completedByUser: new Map<string, string[]>(),
}));

/** The bound values of a drizzle `where`, in order. */
function whereParams(args: unknown): unknown[] {
  const where = (args as { where?: unknown })?.where;
  return dialect.sqlToQuery(where as never).params;
}

vi.mock("@/db", () => ({
  db: {
    query: {
      providerIdentity: {
        findFirst: async (args: unknown) => {
          mocks.directoryReads++;
          if (mocks.directoryDown) throw new Error("directory unavailable");
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
      users: {
        findFirst: async (args: unknown) => {
          const [email] = whereParams(args);
          const id = mocks.usersByEmail.get(String(email));
          return id ? { id } : undefined;
        },
      },
    },
    select: () => ({
      from: () => ({
        where: async (where: unknown) => {
          const [userId] = dialect.sqlToQuery(where as never).params;
          return (mocks.completedByUser.get(String(userId)) ?? []).map(
            (resourceId) => ({ resourceId }),
          );
        },
      }),
    }),
  },
}));

vi.mock("@/coursebuilder/email-list-provider", () => {
  const unreachable = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        mocks.kitCalls.push(String(property));
        throw new Error("Kit is unreachable");
      },
    },
  );
  return {
    emailListProvider: unreachable,
    getSubscriberFresh: () => {
      mocks.kitCalls.push("getSubscriberFresh");
      throw new Error("Kit is unreachable");
    },
  };
});

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  cache: (fn: unknown) => fn,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mocks.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      mocks.written.set(name, value);
    },
  }),
}));

vi.mock("@/server/auth", () => ({
  getServerAuthSession: async () => ({ session: mocks.session }),
}));
vi.mock("./library-query", () => ({ getPurchasedResources: async () => [] }));
vi.mock("./video-facts-query", () => ({
  getCachedVideoGraph: async () => ({}),
}));

import { getSubscriberFromCookie } from "./convertkit";
import { getVideoViewerStatus } from "./video-viewer-status-query";

const KIT_ID = "1234567";

describe("cookie identity with Kit unreachable", () => {
  beforeEach(() => {
    mocks.cookies.clear();
    mocks.written.clear();
    mocks.identities.clear();
    mocks.contacts.clear();
    mocks.usersByEmail.clear();
    mocks.completedByUser.clear();
    mocks.directoryDown = false;
    mocks.directoryReads = 0;
    mocks.kitCalls.length = 0;
    mocks.session = null;
    mocks.identities.set(KIT_ID, "contact-1");
    mocks.contacts.set("contact-1", {
      email: "reader@example.test",
      name: "Reader",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        mocks.kitCalls.push(String(input));
        throw new TypeError("fetch failed: Kit is unreachable");
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    expect(mocks.kitCalls).toEqual([]);
  });

  it("names a broadcast-link reader from the historical Kit id alone", async () => {
    mocks.cookies.set("ck_subscriber_id", KIT_ID);

    await expect(getSubscriberFromCookie()).resolves.toMatchObject({
      id: 1234567,
      email_address: "reader@example.test",
      first_name: "Reader",
    });
    expect(JSON.parse(mocks.written.get("ck_subscriber")!)).toMatchObject({
      id: 1234567,
      email_address: "reader@example.test",
    });
  });

  it("accepts the JSON-quoted id setSubscriberCookie writes", async () => {
    mocks.cookies.set("ck_subscriber_id", JSON.stringify(KIT_ID));

    await expect(getSubscriberFromCookie()).resolves.toMatchObject({
      id: 1234567,
      email_address: "reader@example.test",
    });
  });

  it("keeps the gate cookie answers the directory cannot give", async () => {
    mocks.cookies.set("ck_subscriber_id", KIT_ID);
    mocks.cookies.set(
      "ck_subscriber_gate",
      JSON.stringify({
        id: 1234567,
        state: "active",
        fields: { waitlist_cohort_four: "2026-07-31" },
      }),
    );

    const subscriber = await getSubscriberFromCookie();

    expect(subscriber).toMatchObject({
      state: "active",
      fields: { waitlist_cohort_four: "2026-07-31" },
    });
    expect(JSON.parse(mocks.written.get("ck_subscriber_gate")!)).toMatchObject({
      id: 1234567,
      state: "active",
      fields: { waitlist_cohort_four: "2026-07-31" },
    });
  });

  it("leaves list state unknown rather than claiming the reader is active", async () => {
    mocks.cookies.set("ck_subscriber_id", KIT_ID);

    const subscriber = await getSubscriberFromCookie();

    expect(subscriber?.state).toBeUndefined();
  });

  it("completes a partial cookie that carries an id but no address", async () => {
    mocks.cookies.set(
      "ck_subscriber",
      JSON.stringify({ id: 1234567, state: "inactive", fields: {} }),
    );

    await expect(getSubscriberFromCookie()).resolves.toMatchObject({
      id: 1234567,
      email_address: "reader@example.test",
      state: "inactive",
    });
  });

  it("treats an id the directory does not know as an anonymous visitor", async () => {
    mocks.cookies.set("ck_subscriber_id", "7654321");

    await expect(getSubscriberFromCookie()).resolves.toBeNull();
    expect(mocks.written.size).toBe(0);
  });

  it("treats a failed directory read as an anonymous visitor", async () => {
    mocks.directoryDown = true;
    mocks.cookies.set("ck_subscriber_id", KIT_ID);

    await expect(getSubscriberFromCookie()).resolves.toBeNull();
  });

  it("never sends a malformed id to the database", async () => {
    mocks.cookies.set("ck_subscriber_id", "1 OR 1=1");

    await expect(getSubscriberFromCookie()).resolves.toBeNull();
    expect(mocks.directoryReads).toBe(0);
  });

  it("shows an email-course learner their watched lessons", async () => {
    mocks.cookies.set("ck_subscriber", JSON.stringify({ id: 1234567 }));
    mocks.usersByEmail.set("reader@example.test", "user-1");
    mocks.completedByUser.set("user-1", ["lesson-1", "lesson-2"]);

    await expect(getVideoViewerStatus()).resolves.toEqual({
      watchedIds: ["lesson-1", "lesson-2"],
      ownedIds: [],
      playback: {},
    });
  });
});
