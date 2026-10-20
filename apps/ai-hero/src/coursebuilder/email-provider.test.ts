import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adapterFindOrCreateUser: vi.fn(),
  findOrCreateUserWithPersonalOrg: vi.fn(),
  sendVerificationRequest: vi.fn(),
}));

vi.mock("@/db", () => ({
  courseBuilderAdapter: {
    getUserByEmail: vi.fn(),
    findOrCreateUser: mocks.adapterFindOrCreateUser,
  },
}));
vi.mock("@/env.mjs", () => ({
  env: {
    POSTMARK_API_KEY: "pm",
    NEXT_PUBLIC_SUPPORT_EMAIL: "team@example.test",
  },
}));
vi.mock("@/lib/find-or-create-user", () => ({
  findOrCreateUserWithPersonalOrg: mocks.findOrCreateUserWithPersonalOrg,
}));
vi.mock("@coursebuilder/email/send-verification-request", () => {
  class PostmarkSendError extends Error {
    constructor(
      readonly status: number,
      readonly postmarkErrorCode?: number,
    ) {
      super(`Postmark request failed with status ${status}`);
      this.name = "PostmarkSendError";
    }
  }
  return {
    PostmarkSendError,
    sendVerificationRequest: mocks.sendVerificationRequest,
  };
});
vi.mock("next-auth/providers/postmark", () => ({
  default: (options: unknown) => ({ id: "postmark", options }),
}));

import { PostmarkSendError } from "@coursebuilder/email/send-verification-request";

import { emailProvider, magicLinkIdentity } from "./email-provider";

describe("magic-link identity port", () => {
  it("mints first-time recipients through the personal-org boundary", async () => {
    mocks.findOrCreateUserWithPersonalOrg.mockResolvedValue({
      user: { id: "u1", email: "new@example.test" },
      isNewUser: true,
    });

    const result = await magicLinkIdentity.findOrCreateUser("new@example.test");

    expect(result.user.id).toBe("u1");
    expect(mocks.findOrCreateUserWithPersonalOrg).toHaveBeenCalledWith(
      "new@example.test",
      undefined,
    );
    expect(mocks.adapterFindOrCreateUser).not.toHaveBeenCalled();
  });

  it("hands that port to sendVerificationRequest", async () => {
    const options = (
      emailProvider as unknown as {
        options: { sendVerificationRequest: (p: unknown) => Promise<void> };
      }
    ).options;
    const params = { identifier: "new@example.test" };

    await options.sendVerificationRequest(params);

    expect(mocks.sendVerificationRequest).toHaveBeenCalledWith(
      params,
      magicLinkIdentity,
    );
  });
});

describe("inactive recipient", () => {
  type Provider = {
    options: { sendVerificationRequest: (p: unknown) => Promise<void> };
  };
  const send = () =>
    (emailProvider as unknown as Provider).options.sendVerificationRequest({
      identifier: "person@example.test",
    });

  it("turns Postmark ErrorCode 406 into a client-safe CredentialsSignin on the error page", async () => {
    mocks.sendVerificationRequest.mockRejectedValueOnce(
      new PostmarkSendError(422, 406),
    );

    const error: any = await send().catch((e) => e);

    expect(error.type).toBe("CredentialsSignin");
    expect(error.code).toBe("EmailInactive");
    expect(error.kind).toBe("error");
    expect(JSON.stringify([error.message, error.code])).not.toContain(
      "person@",
    );
  });

  it("leaves other Postmark failures as they were", async () => {
    mocks.sendVerificationRequest.mockRejectedValueOnce(
      new PostmarkSendError(422, 300),
    );

    const error: any = await send().catch((e) => e);

    expect(error.message).toBe("Postmark request failed with status 422");
    expect(error.code).toBeUndefined();
  });

  it("finds a 406 PostmarkSendError wrapped as a cause", async () => {
    mocks.sendVerificationRequest.mockRejectedValueOnce(
      new Error("wrapped", { cause: new PostmarkSendError(422, 406) }),
    );

    const error: any = await send().catch((e) => e);

    expect(error.code).toBe("EmailInactive");
  });

  it("leaves non-Postmark failures as they were", async () => {
    mocks.sendVerificationRequest.mockRejectedValueOnce(new Error("boom"));

    await expect(send()).rejects.toThrow("boom");
  });
});
