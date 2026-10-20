import { courseBuilderAdapter } from "@/db";
import { env } from "@/env.mjs";
import { CredentialsSignin } from "next-auth";
import Postmark from "next-auth/providers/postmark";

import {
  PostmarkSendError,
  sendVerificationRequest,
} from "@coursebuilder/email/send-verification-request";

/**
 * Identity port handed to the magic-link sender.
 *
 * `sendVerificationRequest` resolves the recipient itself and, unless
 * `CREATE_USER_ON_LOGIN=false`, mints unknown emails through
 * `findOrCreateUser` before Auth.js ever runs, so the `createUser` event
 * never fires for them. Route that call through the app boundary so a
 * first-time login-link request provisions the personal organization.
 *
 * The helper is imported lazily: it pulls in the Inngest client, whose
 * config imports this provider, and a static import would evaluate the
 * cycle before `emailProvider` exists.
 */
export const magicLinkIdentity = {
  ...courseBuilderAdapter,
  findOrCreateUser: async (email: string, name?: string | null) => {
    const { findOrCreateUserWithPersonalOrg } =
      await import("@/lib/find-or-create-user");
    return findOrCreateUserWithPersonalOrg(email, name);
  },
};

/**
 * Postmark answers a send to an inactive address with ErrorCode 406.
 * `@coursebuilder/email` surfaces it as a `PostmarkSendError`, which Auth.js
 * would turn into `?error=Configuration`.
 *
 * Auth.js forwards only a fixed set of error types to the error page, and
 * `CredentialsSignin` is the one that also carries a `code`. Throw it with
 * `kind: 'error'` so it lands on `/error`, where `resolveAuthErrorCode` folds
 * the pair into `EmailInactive`. Nothing about the recipient is attached.
 */
export class EmailInactiveError extends CredentialsSignin {
  static kind = "error";
  code = "EmailInactive";
}

const POSTMARK_INACTIVE_RECIPIENT = 406;

function isInactiveRecipient(error: unknown) {
  const source =
    error instanceof PostmarkSendError
      ? error
      : error instanceof Error
        ? error.cause
        : undefined;
  return (
    source instanceof PostmarkSendError &&
    source.postmarkErrorCode === POSTMARK_INACTIVE_RECIPIENT
  );
}

export const emailProvider = Postmark({
  apiKey: env.POSTMARK_API_KEY,
  from: env.NEXT_PUBLIC_SUPPORT_EMAIL,
  sendVerificationRequest: async (params) => {
    try {
      await sendVerificationRequest(params, magicLinkIdentity);
    } catch (error) {
      if (isInactiveRecipient(error)) throw new EmailInactiveError();
      throw error;
    }
  },
});
