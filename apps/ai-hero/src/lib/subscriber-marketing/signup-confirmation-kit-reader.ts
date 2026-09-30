import { z } from 'zod'

/**
 * Kit reads for the skills confirmation reconciler (row 211). Kit allows an
 * API key 120 requests per rolling minute, shared with everything else AI
 * Hero does in Kit, so one reader keeps well under it: at most 4 requests at
 * once and at most 40 starts a minute. A 429 is honoured by its
 * Retry-After, for every request of the reader, and a request still refused
 * after the backoff fails closed: the caller decides nothing on it.
 */
export const KIT_READER_MAX_CONCURRENT = 4
/** 1.5 s between request starts: at most 40 a minute, a third of Kit's limit. */
export const KIT_READER_MIN_START_INTERVAL_MS = 1_500
/** Attempts for one request that Kit answers 429. */
export const KIT_READER_THROTTLE_ATTEMPTS = 4
/** The longest Retry-After the reader waits out; a longer one is capped. */
export const KIT_READER_MAX_RETRY_AFTER_MS = 60_000
/** Attempts for one request that Kit answers 5xx or never answers. */
export const KIT_READER_SERVER_ATTEMPTS = 3
/**
 * A request Kit hasn't answered in 20 s (its 1000-row pages take up to
 * ~11 s, measured 2026-09-30) is abandoned and counted as no answer, so a
 * stalled read can't hold a step, and under `concurrency: 1` the polls
 * behind it (Macroscope 4143598831).
 */
export const KIT_READER_REQUEST_TIMEOUT_MS = 20_000
const KIT_READER_SERVER_BACKOFF_MS = 250
const KIT_READER_THROTTLE_BACKOFF_MS = 1_000

const KIT_API_BASE = 'https://api.convertkit.com/v4'
const DAY_MS = 24 * 60 * 60 * 1000

export type KitReadStats = {
	/** Every request sent to Kit, retries included. */
	calls: number
	/** How many of them Kit answered 429. */
	throttled: number
}

export const addKitReadStats = (
	left: KitReadStats,
	right: KitReadStats,
): KitReadStats => ({
	calls: left.calls + right.calls,
	throttled: left.throttled + right.throttled,
})

/** A Kit read that could not be completed. The caller must fail closed. */
export class KitReadUnavailableError extends Error {
	readonly resource: string
	readonly reason: string
	readonly statusCode?: number

	constructor(resource: string, reason: string, statusCode?: number) {
		super(`Kit read unavailable: ${resource}: ${reason}`)
		this.name = 'KitReadUnavailableError'
		this.resource = resource
		this.reason = reason
		this.statusCode = statusCode
	}
}

export type KitReaderOptions = {
	fetch?: typeof fetch
	sleep?: (milliseconds: number) => Promise<void>
	now?: () => number
	maxConcurrent?: number
	minStartIntervalMs?: number
	requestTimeoutMs?: number
}

export type KitReader = {
	/**
	 * GET a Kit v4 path (`forms/1/subscribers`). Answers a 2xx, or a 4xx that
	 * is not a 429 for the caller to judge. Throws `KitReadUnavailableError`
	 * when Kit still throttles, fails or doesn't answer after the retries.
	 */
	get(
		path: string,
		params: Record<string, string>,
		options?: {
			/**
			 * Checked just before each request goes out: a queued read whose
			 * batch already failed never reaches Kit (Macroscope 4143156021).
			 */
			cancelled?: () => boolean
		},
	): Promise<Response>
	stats(): KitReadStats
	/**
	 * Wait until the next request could start. A step calls it last, so the
	 * next step's first request keeps the pace across step boundaries.
	 */
	settle(): Promise<void>
}

const wait = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

/** Retry-After as seconds or an HTTP date, in milliseconds from now. */
export function retryAfterMs(
	header: string | null,
	now: number,
): number | undefined {
	if (!header) return undefined
	const trimmed = header.trim()
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
	const at = Date.parse(trimmed)
	return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

export function createKitReader(
	apiKey: string,
	options: KitReaderOptions = {},
): KitReader {
	const doFetch = options.fetch ?? fetch
	const sleep = options.sleep ?? wait
	const now = options.now ?? Date.now
	const maxConcurrent = options.maxConcurrent ?? KIT_READER_MAX_CONCURRENT
	const interval =
		options.minStartIntervalMs ?? KIT_READER_MIN_START_INTERVAL_MS
	const timeout = options.requestTimeoutMs ?? KIT_READER_REQUEST_TIMEOUT_MS
	const stats: KitReadStats = { calls: 0, throttled: 0 }
	let active = 0
	const waiting: Array<() => void> = []
	let nextStartAt = 0

	const acquire = async () => {
		if (active >= maxConcurrent)
			await new Promise<void>((resolve) => waiting.push(resolve))
		active += 1
	}
	const release = () => {
		active -= 1
		waiting.shift()?.()
	}
	/** A Retry-After hold: no request of the reader starts before it. */
	let holdUntil = 0
	/**
	 * Reserve the next start slot in call order, then wait for it. A
	 * Retry-After hold set while waiting (by another request's 429) holds
	 * this one too: it re-reserves after the hold (Macroscope 4143156056).
	 */
	const paced = async () => {
		for (;;) {
			const at = Math.max(now(), nextStartAt, holdUntil)
			nextStartAt = at + interval
			const delay = at - now()
			if (delay > 0) await sleep(delay)
			if (holdUntil <= now()) return
		}
	}

	const attempt = async (
		url: URL,
		path: string,
		cancelled?: () => boolean,
	): Promise<Response | undefined> => {
		await paced()
		if (cancelled?.())
			throw new KitReadUnavailableError(path, 'cancelled: another read failed')
		stats.calls += 1
		try {
			return await doFetch(url, {
				headers: { 'X-Kit-Api-Key': apiKey },
				signal: AbortSignal.timeout(timeout),
			})
		} catch {
			return undefined
		}
	}

	return {
		async get(path, params, options) {
			const url = new URL(`${KIT_API_BASE}/${path}`)
			for (const [key, value] of Object.entries(params))
				url.searchParams.set(key, value)
			await acquire()
			try {
				let throttles = 0
				let failures = 0
				for (;;) {
					const response = await attempt(url, path, options?.cancelled)
					if (response?.status === 429) {
						stats.throttled += 1
						throttles += 1
						if (throttles >= KIT_READER_THROTTLE_ATTEMPTS)
							throw new KitReadUnavailableError(
								path,
								`still throttled (429) after ${throttles} attempts`,
								429,
							)
						const delay = Math.min(
							retryAfterMs(response.headers.get('retry-after'), now()) ??
								KIT_READER_THROTTLE_BACKOFF_MS * 2 ** (throttles - 1),
							KIT_READER_MAX_RETRY_AFTER_MS,
						)
						// Kit throttles the key, not this request: every request of
						// the reader waits it out.
						holdUntil = Math.max(holdUntil, now() + delay)
						continue
					}
					if (response && response.status < 500) return response
					failures += 1
					if (failures >= KIT_READER_SERVER_ATTEMPTS)
						throw new KitReadUnavailableError(
							path,
							response
								? `HTTP ${response.status} after ${failures} attempts`
								: `no answer after ${failures} attempts`,
							response?.status,
						)
					await sleep(KIT_READER_SERVER_BACKOFF_MS * 2 ** (failures - 1))
				}
			} finally {
				release()
			}
		},
		stats: () => ({ ...stats }),
		async settle() {
			const delay = Math.max(nextStartAt, holdUntil) - now()
			if (delay > 0) await sleep(delay)
		},
	}
}

/**
 * Half-open slices of subscriber-creation time, `[after, before)`, that
 * together cover every day on which one of these subscribers was created,
 * padded a day each side. Kit's `created_after` is inclusive and
 * `created_before` exclusive, to the second (measured 2026-09-30), so
 * adjacent slices share a boundary instant and a subscriber created exactly
 * on it falls in one slice only. The reader dedupes ids anyway.
 */
export function createdDaySlices(
	createdAts: readonly string[],
	options: { padDays?: number; maxSpanDays?: number } = {},
): Array<{ after: string; before: string }> {
	const pad = options.padDays ?? 1
	const maxSpan = options.maxSpanDays ?? 7
	const days = new Set<number>()
	for (const createdAt of createdAts) {
		const at = Date.parse(createdAt)
		if (Number.isNaN(at))
			throw new KitReadUnavailableError(
				'subscriber',
				`invalid created_at ${createdAt}`,
			)
		days.add(Math.floor(at / DAY_MS))
	}
	const merged: Array<[number, number]> = []
	for (const day of [...days].sort((left, right) => left - right)) {
		const start = day - pad
		const end = day + pad + 1
		const last = merged.at(-1)
		if (last && start <= last[1]) last[1] = Math.max(last[1], end)
		else merged.push([start, end])
	}
	const slices: Array<{ after: string; before: string }> = []
	for (const [start, end] of merged) {
		for (let from = start; from < end; from += maxSpan) {
			slices.push({
				after: new Date(from * DAY_MS).toISOString(),
				before: new Date(Math.min(from + maxSpan, end) * DAY_MS).toISOString(),
			})
		}
	}
	return slices
}

const KitSubscriberIdPage = z.object({
	subscribers: z.array(
		z.object({
			id: z.union([
				z.number().int().positive(),
				z.string().regex(/^[1-9]\d*$/),
			]),
		}),
	),
	pagination: z.object({
		has_next_page: z.boolean(),
		end_cursor: z.string().min(1).nullable().optional(),
	}),
})

/** Kit lists 1000 to a page; this bounds one slice at 100k ids. */
const KIT_SLICE_PAGE_CAP = 100

/**
 * Every subscriber id (any state) under these Kit resources
 * (`sequences/2757199`) created within the slices. Each resource and slice
 * pages on its own, all through the reader's limits. Parsed strictly: an
 * HTTP failure, a malformed page or a next page without a cursor fails the
 * whole read, never yields a shorter list, and stops the other slices.
 */
export async function fetchKitMemberIdsInSlices(
	reader: KitReader,
	resources: readonly string[],
	slices: ReadonlyArray<{ after: string; before: string } | 'whole'>,
): Promise<Set<string>> {
	const byResource = await fetchKitMemberIdsByResource(
		reader,
		resources,
		slices,
	)
	return new Set([...byResource.values()].flatMap((ids) => [...ids]))
}

/**
 * The same read, the ids kept per resource. A `'whole'` slice reads the
 * resource's whole list, unfiltered.
 */
export async function fetchKitMemberIdsByResource(
	reader: KitReader,
	resources: readonly string[],
	slices: ReadonlyArray<{ after: string; before: string } | 'whole'>,
): Promise<Map<string, Set<string>>> {
	const byResource = new Map(
		resources.map((resource) => [resource, new Set<string>()]),
	)
	let failed = false
	const readSlice = async (
		resource: string,
		slice: { after: string; before: string } | 'whole',
	) => {
		let cursor: string | undefined
		for (let page = 0; ; page++) {
			if (failed) return
			if (page >= KIT_SLICE_PAGE_CAP)
				throw new KitReadUnavailableError(
					resource,
					`more than ${KIT_SLICE_PAGE_CAP} pages in ${slice === 'whole' ? 'the whole list' : `${slice.after}..${slice.before}`}`,
				)
			const response = await reader.get(
				`${resource}/subscribers`,
				{
					status: 'all',
					per_page: '1000',
					...(slice === 'whole'
						? {}
						: { created_after: slice.after, created_before: slice.before }),
					...(cursor ? { after: cursor } : {}),
				},
				{ cancelled: () => failed },
			)
			if (!response.ok)
				throw new KitReadUnavailableError(
					resource,
					`HTTP ${response.status}`,
					response.status,
				)
			const parsed = KitSubscriberIdPage.safeParse(
				await response.json().catch(() => undefined),
			)
			if (!parsed.success)
				throw new KitReadUnavailableError(resource, 'malformed page')
			const ids = byResource.get(resource)!
			for (const subscriber of parsed.data.subscribers)
				ids.add(String(subscriber.id))
			if (!parsed.data.pagination.has_next_page) return
			cursor = parsed.data.pagination.end_cursor ?? undefined
			if (!cursor)
				throw new KitReadUnavailableError(
					resource,
					'next page without a cursor',
				)
		}
	}
	await Promise.all(
		resources.flatMap((resource) =>
			slices.map((slice) =>
				readSlice(resource, slice).catch((error: unknown) => {
					failed = true
					throw error
				}),
			),
		),
	)
	return byResource
}

const KitTagPage = z.object({
	tags: z.array(
		z.object({
			id: z.union([
				z.number().int().positive(),
				z.string().regex(/^[1-9]\d*$/),
			]),
		}),
	),
	pagination: z.object({
		has_next_page: z.boolean(),
		end_cursor: z.string().min(1).nullable().optional(),
	}),
})

const KIT_TAG_PAGE_CAP = 20

/**
 * The tag ids on one subscriber, fresh from Kit, or `not-found` when Kit
 * has no such subscriber (404). Any other failure throws: no opt-out
 * evidence, no decision.
 */
export async function fetchKitSubscriberTagIds(
	reader: KitReader,
	kitSubscriberId: string,
): Promise<Set<string> | 'not-found'> {
	const resource = `subscribers/${kitSubscriberId}/tags`
	const tagIds = new Set<string>()
	let cursor: string | undefined
	for (let page = 0; page < KIT_TAG_PAGE_CAP; page++) {
		const response = await reader.get(resource, {
			per_page: '1000',
			...(cursor ? { after: cursor } : {}),
		})
		if (response.status === 404) return 'not-found'
		if (!response.ok)
			throw new KitReadUnavailableError(
				resource,
				`HTTP ${response.status}`,
				response.status,
			)
		const parsed = KitTagPage.safeParse(
			await response.json().catch(() => undefined),
		)
		if (!parsed.success)
			throw new KitReadUnavailableError(resource, 'malformed page')
		for (const tag of parsed.data.tags) tagIds.add(String(tag.id))
		if (!parsed.data.pagination.has_next_page) return tagIds
		cursor = parsed.data.pagination.end_cursor ?? undefined
		if (!cursor)
			throw new KitReadUnavailableError(resource, 'next page without a cursor')
	}
	throw new KitReadUnavailableError(
		resource,
		`more than ${KIT_TAG_PAGE_CAP} pages`,
	)
}
