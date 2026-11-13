import { courseBuilderAdapter } from "@/db";
import { env } from "@/env.mjs";
import { parseDrovrSignupDeliveryConfig } from "@/lib/subscriber-marketing/drovr-doi-signup";
import {
  validateEmailWithDrovr,
  type DrovrEmailValidation,
} from "@/lib/subscriber-marketing/drovr-email-validation";
import { getLogContext, log } from "@/server/logger";
import { toFragmentLoginUrl } from "@/server/magic-link-fragment";
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

/** Only a domain travels through Auth.js's public error URL, never an address. */
export class EmailRejectedError extends CredentialsSignin {
  static kind = "error";
  code = "EmailRejected";

  constructor(email: string, suggestion?: string) {
    super();
    const [local, domain, extra] = suggestion?.split("@") ?? [];
    if (
      local === email.trim().toLowerCase().split("@")[0] &&
      domain &&
      !extra &&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    )
      this.code += `:${domain}`;
  }
}

/**
 * A short, stable digest of the normalized address so repeat attempts can be
 * tied together in logs without ever logging the address itself.
 */
export async function emailLogHash(email: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Shared with egghead so one Axiom query and alarm covers both apps. */
export const EMAIL_VALIDATION_EVENT = "email_validation.decision";

/**
 * One structured decision per check, in the shape egghead logs. Existing
 * users are checked and logged, but their verdict is never enforced.
 * Never carries the address: only its domain (plus a hash added by the caller).
 */
export function emailValidationDecision(
  email: string,
  result: DrovrEmailValidation,
  { existingUser, durationMs }: { existingUser: boolean; durationMs: number },
) {
  const known = result.verdict === "unknown" ? undefined : result;
  const blocked = !existingUser && result.verdict === "reject";
  const domain = email.trim().toLowerCase().split("@");
  return {
    app: "ai-hero",
    provider: "drovr",
    surface: "magic_link_login",
    mode: "enforce",
    outcome: existingUser
      ? "skipped"
      : result.verdict === "unknown"
        ? "fail_open"
        : result.verdict,
    verdict: result.verdict,
    reason: result.verdict === "reject" ? result.reason : null,
    would_block: result.verdict === "reject",
    blocked,
    fail_reason: result.verdict === "unknown" ? result.error : null,
    http_status:
      result.verdict === "unknown" ? (result.httpStatus ?? null) : null,
    skip_reason: existingUser ? "existing_user" : null,
    has_suggestion: Boolean(known?.suggestion),
    policy_version: known?.policyVersion ?? null,
    email_domain: domain.length === 2 && domain[1] ? domain[1] : null,
    duration_ms: durationMs,
    request_id: getLogContext()?.requestId ?? null,
  };
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

// Transactional welcome, redemption and transfer emails retain their existing
// one-day default (transfers may supply their own explicit expiresAt).
export const emailProvider = Postmark({
  maxAge: 86400,
  apiKey: env.POSTMARK_API_KEY,
  from: env.NEXT_PUBLIC_SUPPORT_EMAIL,
  sendVerificationRequest: async (params) => {
    try {
      if (
        env.AIH_EMAIL_VALIDATION_ENABLED === "true" &&
        courseBuilderAdapter.getUserByEmail
      ) {
        const started = performance.now();
        // Give every address the same bounded validation wait. Existing users
        // ignore the verdict; provider failures resolve to unknown for everyone.
        const [user, result] = await Promise.all([
          courseBuilderAdapter.getUserByEmail(params.identifier),
          // Same base URL resolution as every other drovr client: production
          // sets only DROVR_SHADOW_INGEST_URL, not DROVR_API_BASE_URL.
          validateEmailWithDrovr(
            params.identifier,
            parseDrovrSignupDeliveryConfig(env),
          ),
        ]);
        const blocked = !user && result.verdict === "reject";
        await log
          .info(EMAIL_VALIDATION_EVENT, {
            ...emailValidationDecision(params.identifier, result, {
              existingUser: Boolean(user),
              durationMs: Math.round(performance.now() - started),
            }),
            email_hash: await emailLogHash(params.identifier).catch(() => null),
          })
          .catch(() => undefined);
        if (blocked) {
          throw new EmailRejectedError(
            params.identifier,
            result.verdict === "reject" ? result.suggestion : undefined,
          );
        }
      }
      // Auth.js builds `/api/auth/callback/postmark?token=&email=`. Emailing a
      // fragment link instead keeps the token and email out of request logs.
      await sendVerificationRequest(
        { ...params, url: toFragmentLoginUrl(params.url) },
        magicLinkIdentity,
      );
    } catch (error) {
      if (isInactiveRecipient(error)) throw new EmailInactiveError();
      throw error;
    }
  },
});

// Auth.js resolves provider.options over the provider defaults. Set both so
// direct consumers and Auth.js agree on the self-requested login lifetime.
export const loginEmailProvider = {
  ...emailProvider,
  maxAge: 3600,
  options: { ...emailProvider.options, maxAge: 3600 },
};
