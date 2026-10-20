import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CredentialsSignin } from 'next-auth'
import Postmark from 'next-auth/providers/postmark'

import { sendVerificationRequest } from '@coursebuilder/email/send-verification-request'

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
 * Postmark answers a send to an inactive address with ErrorCode 406, but
 * `@coursebuilder/email` throws a bare "failed with status N" error that drops
 * the body. Auth.js would turn that into `?error=Configuration`.
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

const POSTMARK_SEND_URL = 'https://api.postmarkapp.com/email'
const POSTMARK_INACTIVE_RECIPIENT = 406
const capture = new AsyncLocalStorage<{ errorCode?: number }>()
const CAPTURE_INSTALLED = Symbol.for('aihero.postmarkErrorCapture')

/**
 * Records only the numeric Postmark ErrorCode of a failed send, and only while
 * a magic-link send is running. Responses are cloned, so the package still
 * reads the original body. If another layer replaces `fetch` afterwards the
 * capture goes quiet and failures keep their old behaviour.
 */
function installPostmarkErrorCapture() {
	const current = globalThis.fetch as typeof fetch & {
		[CAPTURE_INSTALLED]?: true
	}
	if (current[CAPTURE_INSTALLED]) return
	const wrapped = (async (input, init) => {
		const response = await current(input, init)
		const store = capture.getStore()
		if (store && !response.ok) {
			try {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.href
							: input.url
				if (url === POSTMARK_SEND_URL) {
					const body: unknown = await response.clone().json()
					const errorCode = (body as { ErrorCode?: unknown } | null)?.ErrorCode
					if (typeof errorCode === 'number') store.errorCode = errorCode
				}
			} catch {
				// Capture is best effort; never disturb the send.
			}
		}
		return response
	}) as typeof fetch & { [CAPTURE_INSTALLED]?: true }
	wrapped[CAPTURE_INSTALLED] = true
	globalThis.fetch = wrapped
}

export const emailProvider = Postmark({
	apiKey: env.POSTMARK_API_KEY,
	from: env.NEXT_PUBLIC_SUPPORT_EMAIL,
	sendVerificationRequest: async (params) => {
		installPostmarkErrorCapture()
		const store: { errorCode?: number } = {}
		try {
			await capture.run(store, () =>
				sendVerificationRequest(params, magicLinkIdentity),
			)
		} catch (error) {
			if (store.errorCode === POSTMARK_INACTIVE_RECIPIENT) {
				throw new EmailInactiveError()
			}
			throw error
		}
	},
})
