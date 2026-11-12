import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { validateEmailWithDrovr } from '@/lib/subscriber-marketing/drovr-email-validation'
import { log } from '@/server/logger'
import { toFragmentLoginUrl } from '@/server/magic-link-fragment'
import { CredentialsSignin } from 'next-auth'
import Postmark from 'next-auth/providers/postmark'

import {
	PostmarkSendError,
	sendVerificationRequest,
} from '@coursebuilder/email/send-verification-request'

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
			await import('@/lib/find-or-create-user')
		return findOrCreateUserWithPersonalOrg(email, name)
	},
}

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
	static kind = 'error'
	code = 'EmailInactive'
}

/** Only a domain travels through Auth.js's public error URL, never an address. */
export class EmailRejectedError extends CredentialsSignin {
	static kind = 'error'
	code = 'EmailRejected'

	constructor(email: string, suggestion?: string) {
		super()
		const [local, domain, extra] = suggestion?.split('@') ?? []
		if (
			local === email.trim().toLowerCase().split('@')[0] &&
			domain &&
			!extra &&
			/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
		)
			this.code += `:${domain}`
	}
}

const POSTMARK_INACTIVE_RECIPIENT = 406

function isInactiveRecipient(error: unknown) {
	const source =
		error instanceof PostmarkSendError
			? error
			: error instanceof Error
				? error.cause
				: undefined
	return (
		source instanceof PostmarkSendError &&
		source.postmarkErrorCode === POSTMARK_INACTIVE_RECIPIENT
	)
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
				env.AIH_EMAIL_VALIDATION_ENABLED === 'true' &&
				courseBuilderAdapter.getUserByEmail &&
				!(await courseBuilderAdapter.getUserByEmail(params.identifier))
			) {
				const started = performance.now()
				const result = await validateEmailWithDrovr(params.identifier, {
					baseUrl: env.DROVR_API_BASE_URL,
					apiKey: env.DROVR_API_KEY_ORG_AIHERO,
				})
				const fields = {
					verdict: result.verdict,
					reason: result.verdict === 'reject' ? result.reason : undefined,
					policyVersion:
						result.verdict === 'unknown' ? undefined : result.policyVersion,
					ms: Math.round(performance.now() - started),
				}
				await log
					.info('auth.email_validation.checked', fields)
					.catch(() => undefined)
				if (result.verdict === 'reject') {
					await log
						.info('auth.email_validation.blocked', fields)
						.catch(() => undefined)
					throw new EmailRejectedError(params.identifier, result.suggestion)
				}
			}
			// Auth.js builds `/api/auth/callback/postmark?token=&email=`. Emailing a
			// fragment link instead keeps the token and email out of request logs.
			await sendVerificationRequest(
				{ ...params, url: toFragmentLoginUrl(params.url) },
				magicLinkIdentity,
			)
		} catch (error) {
			if (isInactiveRecipient(error)) throw new EmailInactiveError()
			throw error
		}
	},
})

// Auth.js resolves provider.options over the provider defaults. Set both so
// direct consumers and Auth.js agree on the self-requested login lifetime.
export const loginEmailProvider = {
	...emailProvider,
	maxAge: 3600,
	options: { ...emailProvider.options, maxAge: 3600 },
}
