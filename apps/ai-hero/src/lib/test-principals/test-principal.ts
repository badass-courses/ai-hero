import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

import {
	SYNTHETIC_PRINCIPAL_EMAIL_DOMAIN,
	SYNTHETIC_PRINCIPAL_ID_PREFIX,
} from '@/lib/synthetic-principal'

/**
 * Throwaway ai-hero principals for drovr's link tests (#36T, T3b): mint,
 * use, delete. Each is keyed by the caller's runId, marked synthetic in its
 * ids and address, and never lives past an hour.
 */
export const TEST_PRINCIPAL_TTL_MS = 60 * 60_000
export const TEST_PRINCIPAL_SIGN_IN_TTL_MS = 5 * 60_000
export const MAX_LIVE_TEST_PRINCIPALS = 5
/** Auth.js email provider id; its callback is the one-time sign-in route. */
export const TEST_PRINCIPAL_SIGN_IN_PROVIDER = 'postmark'
export const MAGIC_LINK_CONFIRM_PATH = '/api/auth/magic-link/confirm'
/** @coursebuilder/adapter-drizzle useVerificationToken's multi-click grace. */
export const MAGIC_LINK_REUSE_WINDOW_MS = 90_000

export const TestPrincipalRequestSchema = z
	.object({
		runId: z.string().regex(/^[a-z0-9-]{8,64}$/),
		tenantId: z.string().trim().min(1),
		personas: z.array(z.literal('recipient')).length(1),
		valuePathSlug: z.string().trim().min(1).optional(),
		emailKeys: z.array(z.string().trim().min(1)).max(50).default([]),
		// Ships with T3c; refused explicitly until then, never ignored.
		evergreenCoupon: z.literal('crash-course').optional(),
	})
	.strict()
export type TestPrincipalRequest = z.infer<typeof TestPrincipalRequestSchema>

export type TestPrincipalIdentity = {
	principalId: string
	contactId: string
	email: string
}

/**
 * The same runId always names the same principal, so a retried mint cannot
 * create a second one. The user and contact share the synthetic id.
 *
 * @example testPrincipalIdentity('run-12345678').email // 'run-12345678@synthetic.aihero.invalid'
 */
export function testPrincipalIdentity(runId: string): TestPrincipalIdentity {
	const digest = createHash('sha256')
		.update(`test-principal:${runId}`)
		.digest('hex')
	const id = `${SYNTHETIC_PRINCIPAL_ID_PREFIX}${digest.slice(0, 24)}`
	return {
		principalId: id,
		contactId: id,
		email: `${runId}@${SYNTHETIC_PRINCIPAL_EMAIL_DOMAIN}`,
	}
}

/** The secret Auth.js hashes email tokens with (next-auth setEnvDefaults). */
export function authJsSecret(
	source: Record<string, string | undefined> = process.env,
): string | undefined {
	return source.AUTH_SECRET ?? source.NEXTAUTH_SECRET
}

/**
 * What @auth/core 0.37.2 stores for an email token and checks in its
 * callback: sha256 hex of the raw token followed by the secret.
 */
export function hashVerificationToken(rawToken: string, secret: string): string {
	return createHash('sha256').update(`${rawToken}${secret}`).digest('hex')
}

export function newSignInToken(): string {
	return randomBytes(32).toString('hex')
}

export type TestPrincipalSignIn = {
	url: string
	expiresAt: string
	confirm: { method: 'POST'; path: string }
	steps: string[]
}

/**
 * The magic-link callback URL, parameters in Auth.js order. ai-hero's
 * confirmation step sits in front of the callback, so the runner must also
 * submit the confirm form before a session exists.
 */
export function testPrincipalSignIn(args: {
	origin: string
	email: string
	rawToken: string
	expiresAt: Date
}): TestPrincipalSignIn {
	const url = new URL(
		`/api/auth/callback/${TEST_PRINCIPAL_SIGN_IN_PROVIDER}`,
		args.origin,
	)
	url.search = new URLSearchParams({
		callbackUrl: new URL('/', args.origin).toString(),
		token: args.rawToken,
		email: args.email,
	}).toString()
	return {
		url: url.toString(),
		expiresAt: args.expiresAt.toISOString(),
		confirm: { method: 'POST', path: MAGIC_LINK_CONFIRM_PATH },
		steps: [
			'GET url: 307 to /login/verify with a __Host-aih-magic-link-confirmation cookie',
			`POST ${MAGIC_LINK_CONFIRM_PATH} with that cookie (the Confirm button): session cookie set`,
		],
	}
}
