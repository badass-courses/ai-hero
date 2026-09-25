import { z } from 'zod'

import { isPlausibleUnsubscribeToken } from './drovr-unsubscribe-page'

/**
 * The aihero.dev double opt-in confirm page is presentation only. drovr
 * owns the token, the confirmation, and the answer; this module reads
 * drovr's state for a token and posts the reader's button press back. It
 * never verifies or signs a token and holds no secret: the token is the
 * credential. Opening the page changes nothing; only the button's POST
 * confirms (mail scanners open every link).
 */

export const DrovrConfirmState = z.object({
	status: z.enum(['awaiting', 'confirmed', 'expired', 'suppressed']),
	formId: z.string().min(1),
	tenantId: z.string().min(1),
})
export type DrovrConfirmState = z.infer<typeof DrovrConfirmState>

const ConfirmReply = z.object({
	status: z.enum(['confirmed', 'already-confirmed']),
})
const ResendReply = z.object({ status: z.literal('requested') })

export type ConfirmLookup =
	| { status: 'ok'; state: DrovrConfirmState }
	| { status: 'invalid-token' }
	| { status: 'unavailable'; reason: string }

/** What a Confirm or a resend press came to. */
export type ConfirmOutcome =
	| 'confirmed'
	| 'already-confirmed'
	| 'expired'
	| 'suppressed'
	| 'resent'
	| 'invalid-token'
	| 'unavailable'

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export type DrovrConfirmClientConfig = {
	baseUrl: string | undefined
	fetch?: Fetcher
	timeoutMs?: number
}

/** Same `v1.<payload>.<mac>` outer shape as the unsubscribe token. */
export const isPlausibleConfirmToken = isPlausibleUnsubscribeToken

async function send(
	config: DrovrConfirmClientConfig,
	path: string,
	init: RequestInit,
): Promise<Response | { unavailable: string }> {
	if (!config.baseUrl) return { unavailable: 'drovr-api-not-configured' }
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 8_000)
	try {
		return await (config.fetch ?? fetch)(`${config.baseUrl}${path}`, {
			...init,
			cache: 'no-store',
			signal: controller.signal,
		})
	} catch {
		return { unavailable: 'drovr-unreachable' }
	} finally {
		clearTimeout(timer)
	}
}

const jsonBody = async (response: Response) =>
	await response.json().catch(() => undefined)

/** `GET /confirm/state?t=<token>`: a read, no side effects. */
export async function readConfirmState(
	token: string | undefined,
	config: DrovrConfirmClientConfig,
): Promise<ConfirmLookup> {
	if (!token || !isPlausibleConfirmToken(token)) {
		return { status: 'invalid-token' }
	}
	const response = await send(
		config,
		`/confirm/state?t=${encodeURIComponent(token)}`,
		{ method: 'GET', headers: { accept: 'application/json' } },
	)
	if (!(response instanceof Response)) {
		return { status: 'unavailable', reason: response.unavailable }
	}
	// 400 invalid token; 404 a tenant or form with no confirm page. Either
	// way the link cannot be used as sent.
	if (response.status === 400 || response.status === 404) {
		return { status: 'invalid-token' }
	}
	if (response.status !== 200) {
		return { status: 'unavailable', reason: `drovr-${response.status}` }
	}
	const state = DrovrConfirmState.safeParse(await jsonBody(response))
	return state.success
		? { status: 'ok', state: state.data }
		: { status: 'unavailable', reason: 'drovr-bad-reply' }
}

/** `POST /confirm {token}`: the one mutation, behind the page's button. */
export async function submitConfirm(
	token: string | undefined,
	config: DrovrConfirmClientConfig,
): Promise<ConfirmOutcome> {
	if (!token || !isPlausibleConfirmToken(token)) return 'invalid-token'
	const response = await send(config, '/confirm', {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		body: JSON.stringify({ token }),
	})
	if (!(response instanceof Response)) return 'unavailable'
	if (response.status === 410) return 'expired'
	if (response.status === 409) return 'suppressed'
	if (response.status === 400 || response.status === 404) return 'invalid-token'
	if (response.status !== 200) return 'unavailable'
	const reply = ConfirmReply.safeParse(await jsonBody(response))
	return reply.success ? reply.data.status : 'unavailable'
}

/** `POST /confirm/resend {token}`: asks drovr for a fresh confirmation email. */
export async function requestConfirmResend(
	token: string | undefined,
	config: DrovrConfirmClientConfig,
): Promise<ConfirmOutcome> {
	if (!token || !isPlausibleConfirmToken(token)) return 'invalid-token'
	const response = await send(config, '/confirm/resend', {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		body: JSON.stringify({ token }),
	})
	if (!(response instanceof Response)) return 'unavailable'
	if (response.status === 400 || response.status === 404) return 'invalid-token'
	if (response.status !== 202) return 'unavailable'
	return ResendReply.safeParse(await jsonBody(response)).success
		? 'resent'
		: 'unavailable'
}

export type ConfirmPageView =
	| { kind: 'invalid' }
	| { kind: 'unavailable'; canRetry: boolean }
	| { kind: 'awaiting' }
	| { kind: 'confirmed'; justConfirmed: boolean }
	| { kind: 'expired'; resent: boolean }
	| { kind: 'suppressed' }

const OUTCOMES: ReadonlySet<string> = new Set<ConfirmOutcome>([
	'confirmed',
	'already-confirmed',
	'expired',
	'suppressed',
	'resent',
	'invalid-token',
	'unavailable',
])

/** The `result` a POST redirected back with; anything else is ignored. */
export function parseConfirmOutcome(
	value: string | undefined,
): ConfirmOutcome | undefined {
	return value && OUTCOMES.has(value) ? (value as ConfirmOutcome) : undefined
}

/**
 * What the page shows. The state comes from drovr's read; the redirect's
 * `result` only picks the words (a fetched `?result=confirmed` changes
 * nothing, since only the POST confirms).
 */
export function confirmPageView(
	lookup: ConfirmLookup,
	result?: ConfirmOutcome,
): ConfirmPageView {
	if (result === 'invalid-token' || lookup.status === 'invalid-token') {
		return { kind: 'invalid' }
	}
	if (lookup.status === 'unavailable') {
		return { kind: 'unavailable', canRetry: false }
	}
	switch (lookup.state.status) {
		case 'awaiting':
			return result === 'unavailable'
				? { kind: 'unavailable', canRetry: true }
				: { kind: 'awaiting' }
		case 'confirmed':
			return {
				kind: 'confirmed',
				justConfirmed: result === 'confirmed',
			}
		case 'expired':
			return { kind: 'expired', resent: result === 'resent' }
		case 'suppressed':
			return { kind: 'suppressed' }
	}
}
