import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { z } from 'zod'
import {
	MAX_SCAN_AGE_MS,
	OLD_SEQUENCE_ID,
	RecoveryRefused,
	type MembershipScan,
} from './held-exit-recover'

export const KIT_REQUEST_TIMEOUT_MS = 60_000
export const KIT_PAGE_ATTEMPTS = 5
export const MAX_RETRY_DELAY_MS = 60_000
const digest = (value: string) =>
	createHash('sha256').update(value).digest('hex')
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const pageSchema = z.object({
	subscribers: z
		.array(
			z.object({
				id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			}),
		)
		.max(1000),
	pagination: z.object({
		has_next_page: z.boolean(),
		end_cursor: z.string().nullable().optional(),
	}),
})
export const checkpointSchema = z
	.object({
		version: z.literal(1),
		scope: hashSchema,
		sequenceId: z.literal(2625552),
		startedAt: z.string().datetime({ offset: true }),
		completedAt: z.string().datetime({ offset: true }),
		pages: z.number().int().min(0).max(500),
		subscribers: z.number().int().nonnegative(),
		cursor: z.string().min(1).optional(),
		cursors: z.array(z.string().min(1)).max(500),
		memberHashes: z.array(hashSchema).max(500_000),
		complete: z.boolean(),
	})
	.refine(
		(value) =>
			new Set(value.memberHashes).size === value.memberHashes.length &&
			value.subscribers === value.memberHashes.length &&
			new Set(value.cursors).size === value.cursors.length &&
			value.subscribers <= value.pages * 1000 &&
			(value.complete
				? value.pages > 0 &&
					value.cursor === undefined &&
					value.cursors.length === value.pages - 1
				: value.pages === value.cursors.length &&
					value.cursor === value.cursors.at(-1)),
	)
export type ScanCheckpoint = z.infer<typeof checkpointSchema>
export type ScanStore = {
	load: () => Promise<unknown>
	save: (value: ScanCheckpoint) => Promise<void>
}
type ScanOptions = {
	apiKey: string
	fetch: typeof fetch
	now: () => string
	maxPages?: number
	scope?: string
	store?: ScanStore
	signal?: AbortSignal
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
	random?: () => number
}
const unavailable = () =>
	new RecoveryRefused({ reason: 'provider-unavailable' })
const fresh = (scan: ScanCheckpoint, now: string) => {
	const start = Date.parse(scan.startedAt),
		end = Date.parse(scan.completedAt),
		current = Date.parse(now)
	return (
		Number.isFinite(current) &&
		start <= end &&
		end <= current &&
		current - start <= MAX_SCAN_AGE_MS
	)
}
const wait = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(unavailable())
			return
		}
		const cancel = () => {
			clearTimeout(timer)
			reject(unavailable())
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', cancel)
			resolve()
		}, ms)
		signal?.addEventListener('abort', cancel, { once: true })
	})
function retryDelay(
	response: Response | undefined,
	attempt: number,
	now: string,
	random: () => number,
) {
	const header = response?.headers.get('Retry-After')
	const retryAfter = header
		? /^\d+(\.\d+)?$/.test(header)
			? Number(header) * 1000
			: Date.parse(header) - Date.parse(now)
		: 0
	// Refuse an unreasonably long provider delay instead of retrying earlier than requested.
	if (Number.isFinite(retryAfter) && retryAfter > MAX_RETRY_DELAY_MS)
		throw unavailable()
	return Math.min(
		MAX_RETRY_DELAY_MS,
		Math.max(
			Number.isFinite(retryAfter) ? retryAfter : 0,
			1000 * 2 ** (attempt - 1) * (0.5 + random() * 0.5),
		),
	)
}

/** One transport boundary: only idempotent GETs retry, before JSON parsing.
 * State sketch: loading -> paging -> checkpointed -> paging | complete;
 * paging -> retryWaiting -> paging (same cursor) | refused. Partial is never proof. */
export async function readKitSequenceScan(
	options: ScanOptions,
): Promise<ScanCheckpoint> {
	const maxPages = options.maxPages ?? 500
	if (
		!options.apiKey.trim() ||
		!Number.isInteger(maxPages) ||
		maxPages < 1 ||
		maxPages > 500
	)
		throw unavailable()
	const scope = digest(
		JSON.stringify([
			options.scope ?? '',
			options.apiKey.trim(),
			OLD_SEQUENCE_ID,
			'status=all',
		]),
	)
	const now = options.now()
	if (!Number.isFinite(Date.parse(now))) throw unavailable()
	let scan: ScanCheckpoint = {
		version: 1,
		scope,
		sequenceId: OLD_SEQUENCE_ID as 2625552,
		startedAt: now,
		completedAt: now,
		pages: 0,
		subscribers: 0,
		cursors: [],
		memberHashes: [],
		complete: false,
	}
	const saved = await options.store?.load()
	if (saved !== undefined) {
		const parsed = checkpointSchema.safeParse(saved)
		if (!parsed.success) throw unavailable()
		if (parsed.data.scope === scope && fresh(parsed.data, now))
			scan = parsed.data
	}
	if (scan.complete) return scan
	const members = new Set(scan.memberHashes)
	while (scan.pages < maxPages) {
		if (!fresh(scan, options.now())) return scan
		const url = new URL(
			`https://api.kit.com/v4/sequences/${OLD_SEQUENCE_ID}/subscribers`,
		)
		url.searchParams.set('status', 'all')
		url.searchParams.set('per_page', '1000')
		if (scan.cursor) url.searchParams.set('after', scan.cursor)
		let response: Response | undefined
		for (let attempt = 1; attempt <= KIT_PAGE_ATTEMPTS; attempt++) {
			if (options.signal?.aborted) throw unavailable()
			const controller = new AbortController()
			const timeout = AbortSignal.timeout(KIT_REQUEST_TIMEOUT_MS)
			const cancel = () => controller.abort(options.signal?.reason)
			const expire = () => controller.abort(timeout.reason)
			options.signal?.addEventListener('abort', cancel, { once: true })
			timeout.addEventListener('abort', expire, { once: true })
			if (options.signal?.aborted) cancel()
			if (timeout.aborted) expire()
			let transient = false
			let parsedPage = false
			try {
				response = await options.fetch(url.toString(), {
					method: 'GET',
					redirect: 'error',
					signal: controller.signal,
					headers: { 'X-Kit-Api-Key': options.apiKey.trim() },
				})
				if (
					response.redirected ||
					(response.url && response.url !== url.toString())
				)
					throw unavailable()
				transient =
					response.status === 429 ||
					(response.status >= 500 && response.status <= 599)
				if (!transient) {
					if (response.status !== 200) throw unavailable()
					// Consume and parse within the timeout. Only a pre-parse timeout may retry.
					const raw: unknown = await response.json()
					const page = pageSchema.safeParse(raw)
					if (!page.success) return scan
					parsedPage = true
					const hashes = page.data.subscribers.map((member) =>
						digest(String(member.id)),
					)
					if (
						hashes.some((hash) => members.has(hash)) ||
						new Set(hashes).size !== hashes.length
					)
						return scan
					const next = page.data.pagination.end_cursor
					if (
						page.data.pagination.has_next_page &&
						(!next || scan.cursors.includes(next) || hashes.length === 0)
					)
						return scan
					hashes.forEach((hash) => members.add(hash))
					scan = {
						...scan,
						pages: scan.pages + 1,
						subscribers: members.size,
						memberHashes: [...members],
						completedAt: options.now(),
						complete: !page.data.pagination.has_next_page,
						cursor: page.data.pagination.has_next_page ? next! : undefined,
						cursors: page.data.pagination.has_next_page
							? [...scan.cursors, next!]
							: scan.cursors,
					}
					await options.store?.save(scan)
					if (scan.complete) return scan
					break
				}
			} catch (error) {
				// Only a request timeout retries. Abort, network errors, parse and checkpoint errors refuse.
				if (options.signal?.aborted || parsedPage) throw unavailable()
				transient =
					timeout.aborted ||
					(error instanceof Error && error.name === 'TimeoutError')
				if (!transient) throw unavailable()
			} finally {
				options.signal?.removeEventListener('abort', cancel)
				timeout.removeEventListener('abort', expire)
			}
			if (!transient || attempt === KIT_PAGE_ATTEMPTS) throw unavailable()
			await response?.body?.cancel()
			await (options.sleep ?? wait)(
				retryDelay(
					response,
					attempt,
					options.now(),
					options.random ?? Math.random,
				),
				options.signal,
			)
			response = undefined
		}
	}
	return scan
}

/** Pure decision: no absent (or present) result from partial, stale or invalid proof. */
export function membershipFromScan(
	scan: ScanCheckpoint,
	subscriberId: string,
	now: string,
): MembershipScan {
	const valid =
		checkpointSchema.safeParse(scan).success &&
		scan.complete &&
		fresh(scan, now) &&
		/^[1-9]\d*$/.test(subscriberId) &&
		Number.isSafeInteger(Number(subscriberId))
	return {
		sequenceId: scan.sequenceId,
		pages: scan.pages,
		subscribers: scan.subscribers,
		startedAt: scan.startedAt,
		completedAt: scan.completedAt,
		complete: valid,
		membership: valid
			? scan.memberHashes.includes(digest(subscriberId))
				? 'present'
				: 'absent'
			: 'unknown',
		fingerprint: digest(
			JSON.stringify([
				scan.version,
				scan.scope,
				scan.sequenceId,
				scan.startedAt,
				scan.completedAt,
				scan.pages,
				scan.subscribers,
				scan.cursor ?? null,
				scan.cursors,
				scan.memberHashes,
				scan.complete,
			]),
		),
	}
}

/** Public envelope strips the cursor and membership index. */
export function readKitExitMembership(
	options: ScanOptions & { subscriberId: string },
) {
	return Effect.tryPromise({
		try: async (signal) =>
			membershipFromScan(
				await readKitSequenceScan({ ...options, signal }),
				options.subscriberId,
				options.now(),
			),
		catch: () => unavailable(),
	})
}
