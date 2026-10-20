import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: async () => new Headers({ "x-vercel-id": "iad1::req-123" }),
}));
vi.mock("@/db", () => ({
  courseBuilderAdapter: {},
  db: {
    query: { resourceProgress: { findFirst: mocks.findFirst } },
    insert: () => ({ values: mocks.insert }),
    update: () => ({ set: () => ({ where: mocks.update }) }),
  },
}));
vi.mock("@/db/schema", () => ({
  resourceProgress: { resourceId: "resourceId", userId: "userId" },
}));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock("@/inngest/inngest.server", () => ({
  inngest: { send: mocks.send },
}));
vi.mock("@/lib/find-or-create-user", () => ({
  findOrCreateUserWithPersonalOrg: vi.fn(),
}));
vi.mock("@/server/auth", () => ({
  getServerAuthSession: async () => ({
    session: { user: { id: "user-1", email: "learner@example.test" } },
  }),
}));
vi.mock("@/server/logger", () => ({
  log: { warn: mocks.warn, error: mocks.error, debug: vi.fn() },
  getLogContext: () => undefined,
}));
vi.mock("@/server/perf", () => ({ measureIfSlow: vi.fn() }));
vi.mock("@/schemas/subscriber", () => ({ SubscriberSchema: {} }));

import { setProgressForResource } from "./progress";

describe("setProgressForResource Inngest send handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue(undefined);
    mocks.insert.mockResolvedValue(undefined);
  });

  it("saves and returns progress when every send attempt fails", async () => {
    mocks.send.mockRejectedValue(new TypeError("fetch failed"));

    const progress = await setProgressForResource({
      resourceId: "lesson-1",
      isCompleted: true,
    });

    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(progress).toMatchObject({
      userId: "user-1",
      resourceId: "lesson-1",
    });
    expect(mocks.send).toHaveBeenCalledTimes(3);
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.warn.mock.calls[0]![0]).toBe("progress.inngest_send_failed");
    expect(mocks.error).not.toHaveBeenCalled();
    const logged = JSON.stringify(mocks.warn.mock.calls);
    expect(logged).not.toContain("user-1");
    expect(logged).not.toContain("learner@example.test");
  });

  it("retries once and stays quiet when the second send succeeds", async () => {
    mocks.send
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ids: ["e1"] });

    const progress = await setProgressForResource({
      resourceId: "lesson-1",
      isCompleted: true,
    });

    expect(progress).not.toBeNull();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
