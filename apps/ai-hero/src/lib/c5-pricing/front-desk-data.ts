import {
	decodeBindingQuotes,
	decodePolicy,
	type BindingQuoteData,
	type PricingPolicyData,
} from '@ai-hero/front-desk-support/pricing'

/**
 * front-desk serves the C5 pricing policy and each buyer's binding quotes as
 * data; the engine runs here. Both reads are plain HTTP with a bearer, decoded
 * by the vendored engine's own decoders.
 *
 * - Policy: `GET /api/pricing/policy?productId=…` with the pricing token. It
 *   is versioned and cached stale-while-revalidate everywhere, matching the
 *   route's `max-age=300, stale-while-revalidate=86400`, and revalidated with
 *   `If-None-Match`. Time windows are evaluated against `now` locally, so a
 *   cached policy is safe at checkout too.
 * - Quotes: `POST /api/binding-quotes` with the quotes token. A quote can only
 *   lower a price, so display reads them stale-while-revalidate and checkout
 *   reads them fresh. A failed read is an error, never an empty list.
 */

export type DataRead<A> =
	| { readonly ok: true; readonly value: A }
	| { readonly ok: false; readonly reason: string }

export type PolicyDocument = {
	readonly version: string
	readonly policy: PricingPolicyData
}

export const POLICY_PATH = '/api/pricing/policy'
export const BINDING_QUOTES_PATH = '/api/binding-quotes'
/** Matches the policy route's `max-age=300`. */
export const POLICY_FRESH_MS = 5 * 60_000
/** Matches the policy route's `stale-while-revalidate=86400`. */
export const POLICY_MAX_STALE_MS = 24 * 60 * 60_000
/** Display may reuse a buyer's quotes this long before revalidating. */
export const QUOTES_FRESH_MS = 60_000
/** Display never uses a buyer's quotes older than this. */
export const QUOTES_MAX_STALE_MS = 10 * 60_000
export const FRONT_DESK_DATA_TIMEOUT_MS = 4_000
const QUOTES_CACHE_LIMIT = 1_000

type Clock = () => number

type Entry<A> = {
	value: A
	etag?: string | null
	fetchedAt: number
	refreshing?: Promise<unknown>
}

/**
 * One value, cached stale-while-revalidate. A fresh entry is served as is. A
 * stale one inside `maxStaleMs` is served while one background revalidation
 * runs. Past that, or with nothing cached, the caller waits for a load; a
 * failed load keeps any entry still inside `maxStaleMs`. `fresh` always waits
 * for a load and never falls back.
 */
class SwrCell<A> {
	private entry: Entry<A> | null = null
	private inflight: Promise<DataRead<A>> | null = null

	constructor(
		private readonly load: (
			previous: Entry<A> | null,
		) => Promise<DataRead<{ value: A; etag?: string | null }>>,
		private readonly options: {
			readonly freshMs: number
			readonly maxStaleMs: number
			readonly now: Clock
		},
	) {}

	async read({ fresh = false }: { fresh?: boolean } = {}): Promise<
		DataRead<A>
	> {
		const entry = this.entry
		const age = entry ? this.options.now() - entry.fetchedAt : Infinity
		if (!fresh && entry && age < this.options.freshMs)
			return { ok: true, value: entry.value }
		if (!fresh && entry && age < this.options.maxStaleMs) {
			if (!entry.refreshing) {
				entry.refreshing = this.refresh().finally(() => {
					entry.refreshing = undefined
				})
			}
			return { ok: true, value: entry.value }
		}
		// A fresh read starts its own load: it never joins a revalidation that
		// display started earlier.
		const loaded = await (fresh ? this.loadNow() : this.refresh())
		if (loaded.ok || fresh) return loaded
		const kept = this.entry
		return kept && this.options.now() - kept.fetchedAt < this.options.maxStaleMs
			? { ok: true, value: kept.value }
			: loaded
	}

	/** Single flight: concurrent non-fresh readers share one load. */
	private refresh(): Promise<DataRead<A>> {
		if (this.inflight) return this.inflight
		this.inflight = this.loadNow().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	private loadNow(): Promise<DataRead<A>> {
		return this.load(this.entry)
			.then((result): DataRead<A> => {
				if (!result.ok) return result
				this.entry = {
					value: result.value.value,
					etag: result.value.etag,
					fetchedAt: this.options.now(),
				}
				return { ok: true, value: result.value.value }
			})
			.catch((): DataRead<A> => ({ ok: false, reason: 'load-threw' }))
	}
}

export type FrontDeskDataOptions = {
	readonly url: string
	readonly pricingToken: string
	/** Unset: quote reads fail, so checkout holds and display is provisional. */
	readonly quotesToken?: string
	readonly fetch?: typeof fetch
	readonly now?: Clock
	readonly timeoutMs?: number
}

export interface FrontDeskData {
	policy(productId: string): Promise<DataRead<PolicyDocument>>
	bindingQuotes(input: {
		readonly email: string
		readonly productId: string
		readonly quantity: number
		/** Checkout reads fresh; display may reuse a recent answer. */
		readonly fresh: boolean
	}): Promise<DataRead<readonly BindingQuoteData[]>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

export function createFrontDeskData(
	options: FrontDeskDataOptions,
): FrontDeskData {
	const doFetch = options.fetch ?? fetch
	const now = options.now ?? Date.now
	const timeout = options.timeoutMs ?? FRONT_DESK_DATA_TIMEOUT_MS
	const policies = new Map<string, SwrCell<PolicyDocument>>()
	const quotes = new Map<string, SwrCell<readonly BindingQuoteData[]>>()

	const loadPolicy =
		(productId: string) =>
		async (
			previous: Entry<PolicyDocument> | null,
		): Promise<DataRead<{ value: PolicyDocument; etag?: string | null }>> => {
			const url = new URL(POLICY_PATH, options.url)
			url.searchParams.set('productId', productId)
			let response: Response
			try {
				response = await doFetch(url, {
					headers: {
						authorization: `Bearer ${options.pricingToken}`,
						...(previous?.etag ? { 'if-none-match': previous.etag } : {}),
					},
					cache: 'no-store',
					signal: AbortSignal.timeout(timeout),
				})
			} catch {
				return { ok: false, reason: 'policy-unreachable' }
			}
			if (response.status === 304 && previous)
				return {
					ok: true,
					value: { value: previous.value, etag: previous.etag },
				}
			if (response.status !== 200)
				return { ok: false, reason: `policy-http-${response.status}` }
			let body: unknown
			try {
				body = await response.json()
			} catch {
				return { ok: false, reason: 'policy-malformed' }
			}
			if (!isRecord(body) || typeof body.version !== 'string')
				return { ok: false, reason: 'policy-malformed' }
			const decoded = decodePolicy(body.policy)
			if (!decoded.ok) return { ok: false, reason: 'policy-malformed' }
			// The document names one version; a mismatch is not the policy asked for.
			if (decoded.value.version !== body.version)
				return { ok: false, reason: 'policy-version-mismatch' }
			return {
				ok: true,
				value: {
					value: { version: body.version, policy: decoded.value },
					etag: response.headers.get('etag'),
				},
			}
		}

	const loadQuotes =
		(input: { email: string; productId: string; quantity: number }) =>
		async (): Promise<DataRead<{ value: readonly BindingQuoteData[] }>> => {
			if (!options.quotesToken)
				return { ok: false, reason: 'quotes-not-configured' }
			let response: Response
			try {
				response = await doFetch(new URL(BINDING_QUOTES_PATH, options.url), {
					method: 'POST',
					headers: {
						authorization: `Bearer ${options.quotesToken}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify(input),
					cache: 'no-store',
					signal: AbortSignal.timeout(timeout),
				})
			} catch {
				return { ok: false, reason: 'quotes-unreachable' }
			}
			if (response.status !== 200)
				return { ok: false, reason: `quotes-http-${response.status}` }
			let body: unknown
			try {
				body = await response.json()
			} catch {
				return { ok: false, reason: 'quotes-malformed' }
			}
			const decoded = decodeBindingQuotes(body)
			return decoded.ok
				? { ok: true, value: { value: decoded.value } }
				: { ok: false, reason: 'quotes-malformed' }
		}

	return {
		policy(productId) {
			let cell = policies.get(productId)
			if (!cell) {
				cell = new SwrCell(loadPolicy(productId), {
					freshMs: POLICY_FRESH_MS,
					maxStaleMs: POLICY_MAX_STALE_MS,
					now,
				})
				policies.set(productId, cell)
			}
			return cell.read()
		},
		bindingQuotes({ fresh, ...input }) {
			const email = input.email.trim().toLowerCase()
			const key = JSON.stringify([email, input.productId, input.quantity])
			let cell = quotes.get(key)
			if (!cell) {
				// Bounded: the oldest buyer's entry goes first.
				if (quotes.size >= QUOTES_CACHE_LIMIT)
					quotes.delete(quotes.keys().next().value!)
				cell = new SwrCell(loadQuotes({ ...input, email }), {
					freshMs: QUOTES_FRESH_MS,
					maxStaleMs: QUOTES_MAX_STALE_MS,
					now,
				})
				quotes.set(key, cell)
			}
			return cell.read({ fresh })
		},
	}
}
