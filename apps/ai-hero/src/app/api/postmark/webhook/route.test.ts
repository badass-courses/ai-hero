import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/inngest/inngest.server", () => ({
  inngest: { send: mocks.send },
}));
vi.mock("@/server/logger", () => ({
  log: { error: mocks.error },
}));
vi.mock("@/server/with-skill", () => ({
  withSkill: (handler: unknown) => handler,
}));

import { POST } from "./route";

const request = () =>
  new Request("https://example.test/api/postmark/webhook", {
    method: "POST",
    headers: { "course-builder": "secret" },
    body: JSON.stringify({
      RecordType: "Delivery",
      MessageID: "abcdef-1234-message",
      Recipient: "learner@example.test",
    }),
  }) as never;

describe("postmark webhook Inngest send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.POSTMARK_WEBHOOK_SECRET = "secret";
  });

  it("returns 200 when a retry succeeds", async () => {
    mocks.send
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ids: ["e1"] });

    const response = await (POST as any)(request());

    expect(response.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("returns 500 after three failures and logs a hashed id only", async () => {
    mocks.send.mockRejectedValue(new TypeError("fetch failed"));

    const response = await (POST as any)(request());

    expect(response.status).toBe(500);
    expect(mocks.send).toHaveBeenCalledTimes(3);
    expect(mocks.error).toHaveBeenCalledOnce();
    const [, data] = mocks.error.mock.calls[0]!;
    expect(data.recordType).toBe("Delivery");
    expect(data.messageIdHash).toMatch(/^[0-9a-f]{12}$/);
    const logged = JSON.stringify(mocks.error.mock.calls);
    expect(logged).not.toContain("learner@example.test");
    expect(logged).not.toContain("abcdef-1234-message");
  });
});
