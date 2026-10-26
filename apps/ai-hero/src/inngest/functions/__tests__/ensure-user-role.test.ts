import { beforeEach, describe, expect, it, vi } from "vitest";

const { onDuplicateKeyUpdate, values, insert, findFirst, warn } = vi.hoisted(
  () => {
    const onDuplicateKeyUpdate = vi.fn();
    const values = vi.fn(() => ({ onDuplicateKeyUpdate }));
    const insert = vi.fn(() => ({ values }));
    return {
      onDuplicateKeyUpdate,
      values,
      insert,
      findFirst: vi.fn(),
      warn: vi.fn(),
    };
  },
);

vi.mock("@/db", () => ({
  db: { insert, query: { roles: { findFirst } } },
}));
vi.mock("@/db/schema", () => ({ userRoles: { userId: "userId" } }));
vi.mock("@/server/logger", () => ({ log: { warn } }));

import { ensureUserRole } from "../ensure-user-role";

describe("ensureUserRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts with a duplicate-key no-op, so a second run does not throw", async () => {
    findFirst.mockResolvedValue({ id: "role-1" });
    onDuplicateKeyUpdate.mockResolvedValue(undefined);

    await ensureUserRole({ userId: "u1" });
    await expect(ensureUserRole({ userId: "u1" })).resolves.toBeUndefined();

    expect(values).toHaveBeenCalledWith({ roleId: "role-1", userId: "u1" });
    expect(onDuplicateKeyUpdate).toHaveBeenCalledTimes(2);
  });

  it("logs userId only (no email) when the role is missing", async () => {
    findFirst.mockResolvedValue(undefined);
    await ensureUserRole({ userId: "u1" });
    expect(insert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("user-created.role-not-found", {
      userId: "u1",
      roleName: "user",
    });
  });
});
