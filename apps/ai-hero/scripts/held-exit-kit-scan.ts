import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { Effect } from 'effect4'
import { z } from 'zod'
import {
	MAX_SCAN_AGE_MS,
	MAX_PROOF_AGE_AT_WRITE_MS,
	OLD_SEQUENCE_ID,
	RecoveryRefused,
	type MembershipScan,
} from './held-exit-recover'

export const KIT_REQUEST_TIMEOUT_MS = 60_000
export const KIT_PAGE_ATTEMPTS = 5
export const MAX_RETRY_DELAY_MS = 60_000
const digest = (value: string) =>
	createHash('sha256').update(value).digest('hex')
const key = (apiKey: string, label: string) =>
	Buffer.from(hkdfSync('sha256', apiKey.trim(), 'kit-held-exit-v1', label, 32))
const memberHash = (memberKey: Buffer, id: string) =>
	createHmac('sha256', memberKey).update(id).digest('hex')
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const countSchema = z.number().int().nonnegative().max(500_000)
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
		total_count: countSchema.optional(),
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
		subscribers: countSchema,
		expectedTotal: countSchema.nullable(),
		cursor: z.string().min(1).optional(),
		cursors: z.array(z.string().min(1)).max(500),
		memberHashes: z.array(hashSchema).max(500_000),
		complete: z.boolean(),
		mac: hashSchema,
	})
	.refine(
		(value) =>
			new Set(value.memberHashes).size === value.memberHashes.length &&
			value.subscribers === value.memberHashes.length &&
			new Set(value.cursors).size === value.cursors.length &&
			value.subscribers <= value.pages * 1000 &&
			(value.pages === 0 || value.expectedTotal !== null) &&
			(value.complete
				? value.pages > 0 &&
					value.cursor === undefined &&
					value.cursors.length === value.pages - 1 &&
					value.subscribers === value.expectedTotal
				: value.pages === value.cursors.length &&
					value.cursor === value.cursors.at(-1)),
	)
export type ScanCheckpoint = z.infer<typeof checkpointSchema>
export type ScanStore = {
	load: () => Promise<unknown>
	save: (value: ScanCheckpoint) => Promise<void>
	remove?: () => Promise<void>
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
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, item]) => [name, canonical(item)]),
		)
	return value
}
/** Sealing is an in-memory operation. Neither HKDF key is ever persisted. */
export function signCheckpoint(
	scan: Omit<ScanCheckpoint, 'mac'> | ScanCheckpoint,
	apiKey: string,
): ScanCheckpoint {
	const { mac: _ignored, ...fields } = scan as ScanCheckpoint
	const mac = createHmac('sha256', key(apiKey, 'held-exit-checkpoint'))
		.update(JSON.stringify(canonical(fields)))
		.digest('hex')
	return { ...fields, mac }
}
function authenticated(scan: ScanCheckpoint, apiKey: string) {
	if (!apiKey.trim() || !checkpointSchema.safeParse(scan).success) return false
	return timingSafeEqual(
		Buffer.from(scan.mac, 'hex'),
		Buffer.from(signCheckpoint(scan, apiKey).mac, 'hex'),
	)
}
const fresh = (scan: ScanCheckpoint, now: string) => {
	const start = Date.parse(scan.startedAt),
		end = Date.parse(scan.completedAt),
		current = Date.parse(now)
	return (
		Number.isFinite(current) &&
		start <= end &&
		end <= current &&
		end - start <= MAX_SCAN_AGE_MS &&
		(scan.complete
			? current - end <= MAX_PROOF_AGE_AT_WRITE_MS
			: current - start <= MAX_SCAN_AGE_MS)
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
 * loading -> paging -> checkpointed -> paging | complete;
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
	let scan = signCheckpoint(
		{
			version: 1,
			scope,
			sequenceId: OLD_SEQUENCE_ID as 2625552,
			startedAt: now,
			completedAt: now,
			pages: 0,
			subscribers: 0,
			expectedTotal: null,
			cursors: [],
			memberHashes: [],
			complete: false,
		},
		options.apiKey,
	)
	const saved = await options.store?.load()
	if (saved !== undefined) {
		const parsed = checkpointSchema.safeParse(saved)
		if (!parsed.success) throw unavailable()
		if (parsed.data.scope === scope) {
			if (!authenticated(parsed.data, options.apiKey)) throw unavailable()
			if (fresh(parsed.data, now)) scan = parsed.data
			else await options.store?.remove?.()
		}
	}
	if (scan.complete) return scan
	const members = new Set(scan.memberHashes)
	const memberKey = key(options.apiKey, 'held-exit-membership')
	const ensureFresh = () => {
		if (!fresh(scan, options.now()) || options.signal?.aborted)
			throw unavailable()
	}
	while (scan.pages < maxPages) {
		ensureFresh()
		const url = new URL(
			`https://api.kit.com/v4/sequences/${OLD_SEQUENCE_ID}/subscribers`,
		)
		url.searchParams.set('status', 'all')
		url.searchParams.set('per_page', '1000')
		if (scan.pages === 0) url.searchParams.set('include_total_count', 'true')
		if (scan.cursor) url.searchParams.set('after', scan.cursor)
		let response: Response | undefined
		for (let attempt = 1; attempt <= KIT_PAGE_ATTEMPTS; attempt++) {
			ensureFresh()
			const controller = new AbortController()
			const timeout = AbortSignal.timeout(KIT_REQUEST_TIMEOUT_MS)
			const cancel = () => controller.abort(options.signal?.reason)
			const expire = () => controller.abort(timeout.reason)
			options.signal?.addEventListener('abort', cancel, { once: true })
			timeout.addEventListener('abort', expire, { once: true })
			if (options.signal?.aborted) cancel()
			if (timeout.aborted) expire()
			let transient = false,
				parsedPage = false
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
					const raw: unknown = await response.json()
					const page = pageSchema.safeParse(raw)
					if (!page.success) return scan
					parsedPage = true
					const expectedTotal =
						scan.expectedTotal ?? page.data.pagination.total_count
					if (expectedTotal === undefined) return scan
					if (
						page.data.pagination.total_count !== undefined &&
						page.data.pagination.total_count !== expectedTotal
					) {
						await options.store?.remove?.()
						throw unavailable()
					}
					const hashes = page.data.subscribers.map((member) =>
						memberHash(memberKey, String(member.id)),
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
					if (
						members.size + hashes.length > expectedTotal ||
						(!page.data.pagination.has_next_page &&
							members.size + hashes.length !== expectedTotal)
					) {
						await options.store?.remove?.()
						return scan
					}
					hashes.forEach((hash) => members.add(hash))
					scan = signCheckpoint(
						{
							...scan,
							pages: scan.pages + 1,
							subscribers: members.size,
							expectedTotal,
							memberHashes: [...members],
							completedAt: options.now(),
							complete: !page.data.pagination.has_next_page,
							cursor: page.data.pagination.has_next_page ? next! : undefined,
							cursors: page.data.pagination.has_next_page
								? [...scan.cursors, next!]
								: scan.cursors,
						},
						options.apiKey,
					)
					await options.store?.save(scan)
					if (scan.complete) return scan
					break
				}
			} catch (error) {
				// Definitive refusals beat a racing timeout. A timeout must actually own the abort.
				if (error instanceof RecoveryRefused) throw error
				if (
					error instanceof SyntaxError ||
					options.signal?.aborted ||
					parsedPage
				)
					throw unavailable()
				transient =
					timeout.aborted && controller.signal.reason === timeout.reason
				if (!transient) throw unavailable()
			} finally {
				options.signal?.removeEventListener('abort', cancel)
				timeout.removeEventListener('abort', expire)
			}
			if (!transient || attempt === KIT_PAGE_ATTEMPTS) throw unavailable()
			await response?.body?.cancel()
			ensureFresh()
			const delay = retryDelay(
				response,
				attempt,
				options.now(),
				options.random ?? Math.random,
			)
			if (
				Date.parse(options.now()) + delay - Date.parse(scan.startedAt) >
				MAX_SCAN_AGE_MS
			)
				throw unavailable()
			await (options.sleep ?? wait)(delay, options.signal)
			response = undefined
		}
	}
	return scan
}

/** Pure decision: only authenticated, counted, complete and fresh proof supplies membership. */
export function membershipFromScan(
	scan: ScanCheckpoint,
	subscriberId: string,
	now: string,
	apiKey: string,
): MembershipScan {
	const valid =
		authenticated(scan, apiKey) &&
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
			? scan.memberHashes.includes(
					memberHash(key(apiKey, 'held-exit-membership'), subscriberId),
				)
				? 'present'
				: 'absent'
			: 'unknown',
		fingerprint: digest(JSON.stringify(canonical(scan))),
	}
}
/** Public envelope strips the cursor, MAC and membership index. */
export function readKitExitMembership(
	options: ScanOptions & { subscriberId: string },
) {
	return Effect.tryPromise({
		try: async (signal) =>
			membershipFromScan(
				await readKitSequenceScan({ ...options, signal }),
				options.subscriberId,
				options.now(),
				options.apiKey,
			),
		catch: () => unavailable(),
	})
}

const tagPageSchema = z.object({
	tags: z
		.array(
			z.object({
				id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
				tagged_at: z.string().datetime({ offset: true }),
			}),
		)
		.max(1000),
	pagination: z.object({
		has_next_page: z.boolean(),
		end_cursor: z.string().nullable().optional(),
	}),
})
export const MAX_TAG_PAGES = 50

/** Authenticated GET of every tag on one subscriber, all pages. Any short read,
 * bad shape, loop or non-200 throws: a partial tag list is never proof. */
export async function readKitSubscriberTags(options: {
	apiKey: string
	fetch: typeof fetch
	subscriberId: string
}): Promise<{ id: number; taggedAt: string }[]> {
	if (!/^[1-9]\d*$/.test(options.subscriberId) || !options.apiKey.trim())
		throw new RecoveryRefused({ reason: 'exit-proof-unreadable' })
	const tags: { id: number; taggedAt: string }[] = []
	const cursors = new Set<string>()
	let cursor: string | undefined
	for (let page = 0; page < MAX_TAG_PAGES; page++) {
		const url = new URL(
			`https://api.kit.com/v4/subscribers/${options.subscriberId}/tags`,
		)
		url.searchParams.set('per_page', '1000')
		if (cursor) url.searchParams.set('after', cursor)
		let response: Response
		try {
			response = await options.fetch(url.toString(), {
				method: 'GET',
				redirect: 'error',
				signal: AbortSignal.timeout(KIT_REQUEST_TIMEOUT_MS),
				headers: { 'X-Kit-Api-Key': options.apiKey.trim() },
			})
		} catch {
			throw unavailable()
		}
		if (response.redirected || response.status !== 200) throw unavailable()
		const body: unknown = await response.json().catch(() => undefined)
		const decoded = tagPageSchema.safeParse(body)
		if (!decoded.success)
			throw new RecoveryRefused({ reason: 'exit-proof-unreadable' })
		for (const tag of decoded.data.tags)
			tags.push({ id: tag.id, taggedAt: tag.tagged_at })
		const { has_next_page, end_cursor } = decoded.data.pagination
		if (!has_next_page) return tags
		if (!end_cursor || cursors.has(end_cursor))
			throw new RecoveryRefused({ reason: 'exit-proof-unreadable' })
		cursors.add(end_cursor)
		cursor = end_cursor
	}
	throw new RecoveryRefused({ reason: 'exit-proof-unreadable' })
}
