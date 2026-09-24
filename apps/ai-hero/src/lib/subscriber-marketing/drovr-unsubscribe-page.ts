import { z } from 'zod'

/**
 * The aihero.dev unsubscribe page is presentation only. drovr owns the
 * token, the suppression, and the answer; this module reads drovr's state
 * for a token and posts the reader's choice back. It never verifies or
 * signs a token and holds no secret: the token is the credential, and
 * drovr refuses a bad one the same way whether or not the contact exists.
 */

export const UnsubscribeChoice = z.enum(['course', 'all'])
export type UnsubscribeChoice = z.infer<typeof UnsubscribeChoice>

export const DrovrUnsubscribeState = z.object({
	/** Masked at send time, e.g. j***@g***.com. drovr never returns the full address. */
	email: z.string().min(1),
	tenantId: z.string().min(1),
	course: z
		.object({
			journeyId: z.string().min(1),
			subscribed: z.boolean(),
			/** Not in contract v1; used if drovr ever names the course itself. */
			displayName: z.string().min(1).optional(),
		})
		.nullish(),
	all: z.object({ subscribed: z.boolean() }),
	choices: z.array(z.string()).optional(),
})
export type DrovrUnsubscribeState = z.infer<typeof DrovrUnsubscribeState>

export type UnsubscribeLookup =
	| { status: 'ok'; state: DrovrUnsubscribeState }
	| { status: 'invalid-token' }
	| { status: 'unavailable'; reason: string }

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export type DrovrUnsubscribeClientConfig = {
	baseUrl: string | undefined
	fetch?: Fetcher
	timeoutMs?: number
}

/**
 * The token's outer shape (`v1.<payload>.<mac>`, base64url parts). Anything
 * else is refused here without a round trip; drovr still verifies the rest.
 */
const TOKEN_SHAPE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const MAX_TOKEN_LENGTH = 2048

export function isPlausibleUnsubscribeToken(token: string | undefined) {
	return (
		typeof token === 'string' &&
		token.length <= MAX_TOKEN_LENGTH &&
		TOKEN_SHAPE.test(token)
	)
}

/**
 * drovr's API base. DROVR_API_BASE_URL wins; otherwise the origin of the
 * events ingest URL ai-hero already posts to, which is the same Worker.
 */
export function resolveDrovrApiBaseUrl(env: {
	DROVR_API_BASE_URL?: string
	DROVR_SHADOW_INGEST_URL?: string
}): string | undefined {
	const explicit = env.DROVR_API_BASE_URL?.trim()
	if (explicit) return explicit.replace(/\/+$/, '')
	const ingest = env.DROVR_SHADOW_INGEST_URL?.trim()
	if (!ingest) return undefined
	try {
		return new URL(ingest).origin
	} catch {
		return undefined
	}
}

/**
 * Journey ids to the names the email footer uses ("Unsubscribe from the
 * Skills course"). drovr journeys carry no marketing titles (contract §3),
 * so the page owns them. An unknown journey reads as "this course".
 */
const COURSE_NAMES: Record<string, string> = {
	'value-path-skills-course': 'the Skills course',
	'value-path': 'the Skills course',
	'crash-course-evergreen-offer': 'the AI Coding Crash Course emails',
	'shadow-newsletter': 'the AI Hero newsletter',
}

export function courseDisplayName(
	course: DrovrUnsubscribeState['course'],
): string {
	if (!course) return 'this course'
	return course.displayName ?? COURSE_NAMES[course.journeyId] ?? 'this course'
}

async function call(
	config: DrovrUnsubscribeClientConfig,
	path: string,
	init: RequestInit,
): Promise<UnsubscribeLookup> {
	if (!config.baseUrl) {
		return { status: 'unavailable', reason: 'drovr-api-not-configured' }
	}
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 8_000)
	let response: Response
	try {
		response = await (config.fetch ?? fetch)(`${config.baseUrl}${path}`, {
			...init,
			cache: 'no-store',
			signal: controller.signal,
		})
	} catch {
		return { status: 'unavailable', reason: 'drovr-unreachable' }
	} finally {
		clearTimeout(timer)
	}
	// Contract: a token that fails to parse or verify is 400
	// invalid-unsubscribe-token. The page never asks for anything else
	// that drovr would refuse with 400: the choice is validated first.
	if (response.status === 400) return { status: 'invalid-token' }
	if (response.status !== 200) {
		return { status: 'unavailable', reason: `drovr-${response.status}` }
	}
	let body: unknown
	try {
		body = await response.json()
	} catch {
		return { status: 'unavailable', reason: 'drovr-bad-reply' }
	}
	const state = DrovrUnsubscribeState.safeParse(body)
	if (!state.success) {
		return { status: 'unavailable', reason: 'drovr-bad-reply' }
	}
	return { status: 'ok', state: state.data }
}

/** `GET /unsubscribe/state?t=<token>`: no side effects. */
export async function readUnsubscribeState(
	token: string | undefined,
	config: DrovrUnsubscribeClientConfig,
): Promise<UnsubscribeLookup> {
	if (!token || !isPlausibleUnsubscribeToken(token)) {
		return { status: 'invalid-token' }
	}
	return await call(
		config,
		`/unsubscribe/state?t=${encodeURIComponent(token)}`,
		{ method: 'GET', headers: { accept: 'application/json' } },
	)
}

/** `POST /unsubscribe {token, choice}`: idempotent; answers the new state. */
export async function submitUnsubscribeChoice(
	token: string | undefined,
	choice: UnsubscribeChoice,
	config: DrovrUnsubscribeClientConfig,
): Promise<UnsubscribeLookup> {
	if (!token || !isPlausibleUnsubscribeToken(token)) {
		return { status: 'invalid-token' }
	}
	return await call(config, '/unsubscribe', {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
		},
		body: JSON.stringify({ token, choice }),
	})
}

/**
 * What the page shows for a lookup. The footer links preselect a choice:
 * that choice is the primary button, and the other stays one click away.
 * Arriving never unsubscribes by itself (link scanners open every URL);
 * one button press does, with no confirmation step after it.
 */
export type UnsubscribePageView =
	| { kind: 'invalid' }
	| { kind: 'unavailable' }
	| {
			kind: 'all-unsubscribed'
			email: string
			justUpdated: boolean
	  }
	| {
			kind: 'choose'
			email: string
			courseName: string
			/** Primary first. `course` is absent once the course is already off. */
			options: UnsubscribeChoice[]
			courseUnsubscribed: boolean
			justUpdated: boolean
			submitFailed: boolean
	  }

export function unsubscribePageView(
	lookup: UnsubscribeLookup,
	query: {
		choice?: UnsubscribeChoice
		updated?: UnsubscribeChoice
		submitFailed?: boolean
	} = {},
): UnsubscribePageView {
	if (lookup.status === 'invalid-token') return { kind: 'invalid' }
	if (lookup.status === 'unavailable') return { kind: 'unavailable' }
	const { state } = lookup
	if (!state.all.subscribed) {
		return {
			kind: 'all-unsubscribed',
			email: state.email,
			justUpdated: query.updated === 'all',
		}
	}
	const courseSubscribed = state.course?.subscribed ?? false
	const options: UnsubscribeChoice[] = !courseSubscribed
		? ['all']
		: query.choice === 'all'
			? ['all', 'course']
			: ['course', 'all']
	return {
		kind: 'choose',
		email: state.email,
		courseName: courseDisplayName(state.course),
		options,
		courseUnsubscribed: Boolean(state.course) && !courseSubscribed,
		justUpdated: query.updated === 'course' && !courseSubscribed,
		submitFailed: query.submitFailed === true,
	}
}

/** A preselected choice from the footer link (`&choice=course|all`). */
export function parseUnsubscribeChoice(
	value: string | undefined,
): UnsubscribeChoice | undefined {
	const parsed = UnsubscribeChoice.safeParse(value)
	return parsed.success ? parsed.data : undefined
}
