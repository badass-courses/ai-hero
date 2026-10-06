import { Effect } from 'effect'
import { z } from 'zod'
import { MAX_SCAN_AGE_MS, OLD_SEQUENCE_ID, RecoveryRefused, type MembershipScan } from './held-exit-recover'
const pageSchema = z.object({
	subscribers: z.array(z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })).max(1000),
	pagination: z.object({ has_next_page: z.boolean(), end_cursor: z.string().nullable().optional() }),
})

/** Kit has no documented subscriber-to-sequences GET. The signup "probe" is
 * an enrollment POST and cannot supply this proof. Fail closed on any partial
 * status=all sequence scan. No SDK retry, subscriber mutation, tag or rule call. */
export function readKitExitMembership(options: {
	apiKey: string
	subscriberId: string
	fetch: typeof fetch
	now: () => string
	maxPages?: number
}) {
	return Effect.gen(function* () {
		const maxPages = options.maxPages ?? 500
		if (!options.apiKey.trim() || !/^[1-9]\d*$/.test(options.subscriberId) ||
			!Number.isSafeInteger(Number(options.subscriberId)) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500)
			return yield* Effect.fail(new RecoveryRefused({ reason: 'membership-unknown' }))
		const startedAt = options.now()
		let pages = 0
		let subscribers = 0
		let cursor: string | undefined
		const cursors = new Set<string>()
		const seenIds = new Set<number>()
		const result = (membership: MembershipScan['membership'], complete = false): MembershipScan => ({
			membership, complete, sequenceId: OLD_SEQUENCE_ID, pages, subscribers,
			startedAt, completedAt: options.now(),
		})
		for (; pages < maxPages;) {
			if (Date.parse(options.now()) - Date.parse(startedAt) > MAX_SCAN_AGE_MS)
				return result('unknown')
			const url = new URL(`https://api.kit.com/v4/sequences/${OLD_SEQUENCE_ID}/subscribers`)
			url.searchParams.set('status', 'all')
			url.searchParams.set('per_page', '1000')
			if (cursor) url.searchParams.set('after', cursor)
			const raw = yield* Effect.tryPromise({
				try: async (signal) => {
					const response = await options.fetch(url.toString(), { method: 'GET', redirect: 'error',
						signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
						headers: { 'X-Kit-Api-Key': options.apiKey.trim() } })
					if (response.status !== 200 || response.redirected || (response.url && response.url !== url.toString()))
						throw new Error('provider-unavailable')
					const body: unknown = await response.json()
					return body
				}, catch: () => new RecoveryRefused({ reason: 'provider-unavailable' }),
			})
			pages += 1
			const page = pageSchema.safeParse(raw)
			if (!page.success) return result('unknown')
			subscribers += page.data.subscribers.length
			if (page.data.subscribers.some((member) => member.id === Number(options.subscriberId)))
				return result('present')
			for (const member of page.data.subscribers) {
				if (seenIds.has(member.id)) return result('unknown')
				seenIds.add(member.id)
			}
			if (!page.data.pagination.has_next_page) {
				const completed = result('absent', true)
				if (Date.parse(completed.completedAt) - Date.parse(startedAt) > MAX_SCAN_AGE_MS)
					return { ...completed, membership: 'unknown' as const, complete: false }
				return completed
			}
			const next = page.data.pagination.end_cursor
			if (!next || cursors.has(next) || page.data.subscribers.length === 0) return result('unknown')
			cursors.add(next)
			cursor = next
		}
		return result('unknown')
	})
}
