import { LEARNER_FLOW_CERTIFICATE_TEST_EMAIL } from './learner-flow-canary-exclusion'
import { isLearnerFlowFixtureEmail } from './learner-flow-fixture'

const KIT_API = 'https://api.kit.com/v4'
const DEFAULT_READBACK_ATTEMPTS = 5
const DEFAULT_READBACK_DELAY_MS = 500

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export type KitSyntheticSubscriberCleanupResult = {
	status: 'cancelled' | 'already-cancelled' | 'not-found'
	readbackAttempts: number
}

function syntheticSubscriberError(message: string) {
	return new Error(`Synthetic Kit subscriber cleanup failed: ${message}`)
}

async function parseJson(response: Response) {
	const text = await response.text()
	if (!text) return null
	try {
		return JSON.parse(text) as unknown
	} catch {
		throw syntheticSubscriberError('provider response was not JSON')
	}
}

async function requestWithRetry(args: {
	url: string | URL
	apiKey: string
	fetcher: Fetcher
	init?: RequestInit
	sleep: (milliseconds: number) => Promise<void>
	attempts?: number
}) {
	const attempts = args.attempts ?? 4
	let lastStatus: number | null = null
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		let retryDelayMs = attempt * 500
		try {
			const response = await args.fetcher(args.url, {
				...args.init,
				headers: {
					'X-Kit-Api-Key': args.apiKey,
					...(args.init?.headers ?? {}),
				},
				signal: AbortSignal.timeout(30_000),
			})
			lastStatus = response.status
			if (response.ok) return response
			if (response.status === 429) {
				const retryAfterSeconds = Number(response.headers.get('retry-after') ?? 0)
				if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
					retryDelayMs = Math.max(retryDelayMs, retryAfterSeconds * 1000)
				}
			}
			if (response.status !== 429 && response.status < 500) {
				throw syntheticSubscriberError(`provider returned HTTP ${response.status}`)
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Synthetic Kit')) {
				throw error
			}
			if (attempt === attempts) {
				throw syntheticSubscriberError('provider request failed')
			}
		}
		await args.sleep(retryDelayMs)
	}
	throw syntheticSubscriberError(
		lastStatus ? `provider returned HTTP ${lastStatus}` : 'provider request failed',
	)
}

function subscriberPayload(value: unknown) {
	if (!value || typeof value !== 'object') return undefined
	const candidate = 'subscriber' in value ? value.subscriber : value
	if (!candidate || typeof candidate !== 'object') return undefined
	const record = candidate as Record<string, unknown>
	return {
		id:
			typeof record.id === 'number' || typeof record.id === 'string'
				? record.id
				: undefined,
		email:
			typeof record.email_address === 'string'
				? record.email_address.trim().toLowerCase()
				: undefined,
		state: typeof record.state === 'string' ? record.state : undefined,
	}
}

export async function unsubscribeSyntheticKitSubscriber(args: {
	email: string
	apiKey: string
	fetcher?: Fetcher
	sleep?: (milliseconds: number) => Promise<void>
	readbackAttempts?: number
	readbackDelayMs?: number
}): Promise<KitSyntheticSubscriberCleanupResult> {
	const email = args.email.trim().toLowerCase()
	if (
		!isLearnerFlowFixtureEmail(email) &&
		email !== LEARNER_FLOW_CERTIFICATE_TEST_EMAIL
	) {
		throw syntheticSubscriberError('email is outside the synthetic namespace')
	}
	if (!args.apiKey.trim()) {
		throw syntheticSubscriberError('API key is unavailable')
	}
	const fetcher = args.fetcher ?? fetch
	const sleep = args.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
	const listUrl = new URL(`${KIT_API}/subscribers`)
	listUrl.searchParams.set('email_address', email)
	listUrl.searchParams.set('status', 'all')
	listUrl.searchParams.set('per_page', '2')
	const listResponse = await requestWithRetry({
		url: listUrl,
		apiKey: args.apiKey,
		fetcher,
		sleep,
	})
	const listPayload = await parseJson(listResponse)
	if (
		!listPayload ||
		typeof listPayload !== 'object' ||
		!('subscribers' in listPayload) ||
		!Array.isArray(listPayload.subscribers)
	) {
		throw syntheticSubscriberError('provider list response was malformed')
	}
	const subscribers = listPayload.subscribers
	const exact = subscribers.map((value) => {
		const subscriber = subscriberPayload(value)
		if (
			!subscriber ||
			subscriber.id === undefined ||
			!subscriber.email ||
			!subscriber.state
		) {
			throw syntheticSubscriberError('provider list response was malformed')
		}
		if (subscriber.email !== email) {
			throw syntheticSubscriberError('provider returned a mismatched subscriber')
		}
		return subscriber
	})
	if (exact.length === 0) {
		return { status: 'not-found', readbackAttempts: 0 }
	}
	if (exact.length !== 1) {
		throw syntheticSubscriberError('provider returned multiple exact subscribers')
	}
	const subscriber = exact[0]!
	if (subscriber.state === 'cancelled') {
		return { status: 'already-cancelled', readbackAttempts: 1 }
	}
	await requestWithRetry({
		url: `${KIT_API}/subscribers/${subscriber.id}/unsubscribe`,
		apiKey: args.apiKey,
		fetcher,
		sleep,
		init: {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		},
	})
	const readbackAttempts = args.readbackAttempts ?? DEFAULT_READBACK_ATTEMPTS
	const readbackDelayMs = args.readbackDelayMs ?? DEFAULT_READBACK_DELAY_MS
	for (let attempt = 1; attempt <= readbackAttempts; attempt += 1) {
		const response = await requestWithRetry({
			url: `${KIT_API}/subscribers/${subscriber.id}`,
			apiKey: args.apiKey,
			fetcher,
			sleep,
		})
		const state = subscriberPayload(await parseJson(response))?.state
		if (state === 'cancelled') {
			return { status: 'cancelled', readbackAttempts: attempt }
		}
		if (attempt < readbackAttempts) await sleep(readbackDelayMs)
	}
	throw syntheticSubscriberError('cancelled state did not persist')
}
