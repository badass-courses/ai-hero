import { NonRetriableError } from 'inngest'
import { z } from 'zod'
import { newsletterPauseDurationMs } from '@/inngest/functions/newsletter-provider-pause'

import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
} from './drovr-shadow-emitter'
import {
	OWNER_BIRTH_GUARD_MAX_AGE_MS,
	type DrovrReadBackpressure,
	type OwnerBirthSubject,
} from './owner-birth-guard'

export const BIRTH_FEED_MAX_CALLS = 10
export const BIRTH_FEED_GRACE_MS = 5 * 60_000
export const BIRTH_FEED_JOURNEYS = [
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
] as const
const instant = z.string().datetime({ offset: true })
const opaqueCursor = z.string().min(1)
export const BirthFeedPageSchema = z
	.object({
		births: z
			.array(
				z.object({
					contactId: z.string().min(1),
					journeyId: z.string().min(1),
					version: z.number().finite(),
					bornAt: instant,
				}),
			)
			.max(1000),
		nextCursor: opaqueCursor.nullable(),
		resumeCursor: opaqueCursor,
		asOf: instant.nullable(),
	})
	.refine(
		(page) => page.nextCursor === null || page.nextCursor === page.resumeCursor,
	)
export type BirthFeedPage = z.infer<typeof BirthFeedPageSchema>
export const BirthFeedCheckpointSchema = z
	.object({
		schemaVersion: z.literal(1),
		since: instant,
		resumeCursor: opaqueCursor.nullable(),
		asOf: instant.nullable(),
		phase: z.enum(['bootstrap', 'paging', 'caught-up']),
		// Scheduling metadata only: it neither advances a cursor nor proves absence.
		retry: z
			.object({
				notBefore: instant,
				status: z.union([
					z.literal(429),
					z.literal(502),
					z.literal(503),
					z.literal(504),
					z.literal('timeout'),
					z.literal('page-budget'),
					z.literal('5xx'),
				]),
			})
			.optional(),
	})
	.refine((checkpoint) =>
		checkpoint.phase === 'bootstrap'
			? checkpoint.resumeCursor === null && checkpoint.asOf === null
			: checkpoint.resumeCursor !== null,
	)
export type BirthFeedCheckpoint = z.infer<typeof BirthFeedCheckpointSchema>
export type BirthFeedPageRead =
	| { kind: 'page'; page: BirthFeedPage }
	| { kind: 'shed'; backpressure: DrovrReadBackpressure }
	| {
			kind: 'fatal'
			reason: 'request-refused' | 'invalid-response' | 'unavailable'
	  }
export type BirthFeedRequest = { journeyId: string; limit: number } & (
	| { cursor: string; since?: never }
	| { since: string; cursor?: never }
)
export class BirthFeedFailure extends NonRetriableError {
	constructor(readonly reason: string) {
		super(`drovr birth feed: ${reason}`)
	}
}

/** No throwing transport path: an SDK step must not retry GETs past the cap. */
export async function readDrovrBirths(args: {
	request: BirthFeedRequest
	config: { baseUrl: string; apiKey: string }
	fetcher?: typeof fetch
	timeoutMs?: number
}): Promise<BirthFeedPageRead> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 10_000)
	try {
		const { request } = args
		if (
			!request.journeyId ||
			!Number.isInteger(request.limit) ||
			request.limit < 1 ||
			request.limit > 1000 ||
			(request.cursor !== undefined && request.since !== undefined)
		)
			return { kind: 'fatal', reason: 'request-refused' }
		const query = new URLSearchParams({
			journeyId: request.journeyId,
			limit: String(request.limit),
		})
		if (request.cursor !== undefined) query.set('cursor', request.cursor)
		else query.set('since', request.since)
		const response = await (args.fetcher ?? fetch)(
			`${args.config.baseUrl.replace(/\/+$/, '')}/births?${query}`,
			{
				method: 'GET',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${args.config.apiKey}`,
				},
				signal: controller.signal,
			},
		)
		if (
			response.status === 429 ||
			response.status === 502 ||
			response.status === 503 ||
			response.status === 504
		)
			return {
				kind: 'shed',
				backpressure: {
					status: response.status,
					retryAfter: response.headers.get('retry-after') ?? undefined,
				},
			}
		if (response.status === 422)
			return { kind: 'fatal', reason: 'request-refused' }
		if (response.status !== 200) return { kind: 'fatal', reason: 'unavailable' }
		const parsed = BirthFeedPageSchema.safeParse(await response.json())
		if (
			!parsed.success ||
			parsed.data.births.some(
				(birth) => birth.journeyId !== request.journeyId,
			) ||
			(parsed.data.nextCursor !== null &&
				parsed.data.nextCursor === request.cursor)
		)
			return { kind: 'fatal', reason: 'invalid-response' }
		return { kind: 'page', page: parsed.data }
	} catch (error) {
		return controller.signal.aborted ||
			(error instanceof Error &&
				(error.name === 'AbortError' || error.name === 'TimeoutError'))
			? { kind: 'shed', backpressure: { status: 'timeout' } }
			: { kind: 'fatal', reason: 'unavailable' }
	} finally {
		clearTimeout(timer)
	}
}

export interface BirthFeedStore {
	/** Called inside every physical read callback, never in a separate cached
	 * step: lost SDK results/re-execution must also spend the shared quota. */
	reserveCall(runId: string): Promise<void>
	reserveConfirmation(runId: string): Promise<void>
	observeBorn(journeyId: string, contactId: string): Promise<void>
	deferConfirmation(journeyId: string, ownerId: string): Promise<void>
	deferredConfirmations(
		journeyId: string,
		ownerIds: string[],
	): Promise<ReadonlySet<string>>
	load(journeyId: string): Promise<BirthFeedCheckpoint | null>
	consume(args: {
		journeyId: string
		previous: BirthFeedCheckpoint | null
		checkpoint: BirthFeedCheckpoint
		contactIds: string[]
	}): Promise<void>
	members(args: {
		journeyId: string
		contactIds: string[]
	}): Promise<ReadonlySet<string>>
}
export type BirthFeedVerdict = 'born' | 'missing' | 'unknown'
export interface BirthFeedProof {
	reserveConfirmation(): Promise<void>
	observeBorn(journeyId: string, contactId: string): Promise<void>
	deferConfirmation(journeyId: string, ownerId: string): Promise<void>
	judge(
		subjects: readonly OwnerBirthSubject[],
	): Promise<ReadonlyMap<OwnerBirthSubject, BirthFeedVerdict>>
}
type FeedStep = {
	run<T>(id: string, operation: () => Promise<T>): Promise<unknown>
}
export type BirthFeedPreparation =
	| { kind: 'ready'; calls: number; proof: BirthFeedProof }
	| { kind: 'shed'; calls: number; backpressure: DrovrReadBackpressure }

/** Load all positions -> wait if held -> read -> consume page or persist a
 * shed hold at the unchanged position. The next run repeats that request.
 * Shed/fatal never reach reposting. One shared physical ten-call budget. */
export async function prepareBirthFeed(args: {
	step: FeedStep
	store: BirthFeedStore
	startedAtMs: number
	runId: string
	read: (request: BirthFeedRequest) => Promise<BirthFeedPageRead>
	nowMs?: () => number
}): Promise<BirthFeedPreparation> {
	const now = args.nowMs ?? Date.now
	const held = (
		checkpoint: BirthFeedCheckpoint | null,
	): DrovrReadBackpressure | undefined => {
		if (!checkpoint?.retry) return
		const remaining = Date.parse(checkpoint.retry.notBefore) - now()
		if (remaining > 0)
			return {
				status: checkpoint.retry.status,
				retryAfter: String(Math.ceil(remaining / 1000)),
			}
	}
	let calls = 0
	const caughtUp = new Map<string, BirthFeedCheckpoint>()
	const since = new Date(
		args.startedAtMs - OWNER_BIRTH_GUARD_MAX_AGE_MS - BIRTH_FEED_GRACE_MS,
	).toISOString()
	// Inspect every journey's hold before reading ANY journey. A 24h header
	// must survive the wrapper's <=50m sleep and suppress the next hourly tick.
	const loaded = new Map<string, BirthFeedCheckpoint | null>()
	for (const journeyId of BIRTH_FEED_JOURNEYS) {
		// SAFETY: validated store outputs retain their plain shape through SDK JSON.
		const checkpoint = (await args.step.run(
			`birth-feed-load-${journeyId}`,
			() => args.store.load(journeyId),
		)) as BirthFeedCheckpoint | null
		loaded.set(journeyId, checkpoint)
	}
	for (const checkpoint of loaded.values()) {
		const backpressure = held(checkpoint)
		if (backpressure) return { kind: 'shed', calls, backpressure }
	}
	for (const journeyId of BIRTH_FEED_JOURNEYS) {
		let checkpoint = loaded.get(journeyId) ?? null
		for (;;) {
			if (calls >= BIRTH_FEED_MAX_CALLS)
				throw new BirthFeedFailure('page-cap-exceeded')
			const index = calls++
			const request: BirthFeedRequest =
				checkpoint && checkpoint.resumeCursor !== null
					? { journeyId, cursor: checkpoint.resumeCursor, limit: 1000 }
					: { journeyId, since: checkpoint?.since ?? since, limit: 1000 }
			const read = (await args.step.run(
				`birth-feed-read-${index}`,
				async () => {
					// A lost SDK result must not repeat a shed GET before its hold.
					const current = await args.store.load(journeyId)
					if (!current && checkpoint)
						throw new BirthFeedFailure('checkpoint-lost-before-read')
					if (
						current &&
						(current.resumeCursor !== null
							? current.resumeCursor !== request.cursor
							: current.since !== request.since)
					)
						throw new BirthFeedFailure('checkpoint-conflict-before-read')
					const backpressure = held(current)
					if (backpressure)
						return { kind: 'shed', backpressure } satisfies BirthFeedPageRead
					await args.store.reserveCall(args.runId)
					let result: BirthFeedPageRead
					try {
						result = await args.read(request)
					} catch {
						result = { kind: 'fatal', reason: 'unavailable' }
					}
					if (result.kind === 'shed') {
						const at = now()
						await args.store.consume({
							journeyId,
							previous: current,
							checkpoint: {
								...(current ??
									({
										schemaVersion: 1,
										since,
										resumeCursor: null,
										asOf: null,
										phase: 'bootstrap',
									} satisfies BirthFeedCheckpoint)),
								retry: {
									notBefore: new Date(
										at +
											newsletterPauseDurationMs(
												result.backpressure.retryAfter,
												at,
											),
									).toISOString(),
									status: result.backpressure.status,
								},
							},
							contactIds: [],
						})
					}
					return result
				},
			)) as BirthFeedPageRead
			if (read.kind === 'shed') return { ...read, calls }
			if (read.kind === 'fatal') throw new BirthFeedFailure(read.reason)
			const page = read.page
			if (
				checkpoint?.asOf &&
				(page.asOf === null ||
					Date.parse(page.asOf) < Date.parse(checkpoint.asOf))
			)
				throw new BirthFeedFailure('watermark-regressed')
			const next: BirthFeedCheckpoint = {
				schemaVersion: 1,
				since: checkpoint?.since ?? since,
				resumeCursor: page.resumeCursor,
				asOf: page.asOf,
				phase: page.nextCursor === null ? 'caught-up' : 'paging',
			}
			const previous = checkpoint
			await args.step.run(`birth-feed-consume-${index}`, async () => {
				await args.store.consume({
					journeyId,
					previous,
					checkpoint: next,
					contactIds: page.births.map((birth) => birth.contactId),
				})
				return true
			})
			checkpoint = next
			if (page.nextCursor === null) {
				caughtUp.set(journeyId, next)
				break
			}
		}
	}
	return {
		kind: 'ready',
		calls,
		proof: {
			reserveConfirmation: () => args.store.reserveConfirmation(args.runId),
			observeBorn: (journeyId, contactId) =>
				args.store.observeBorn(journeyId, contactId),
			deferConfirmation: (journeyId, ownerId) =>
				args.store.deferConfirmation(journeyId, ownerId),
			async judge(subjects) {
				const result = new Map<OwnerBirthSubject, BirthFeedVerdict>()
				for (const [journeyId, checkpoint] of caughtUp) {
					const group = subjects.filter(
						(subject) => subject.journeyId === journeyId,
					)
					if (!group.length) continue
					const members = await args.store.members({
						journeyId,
						contactIds: [
							...new Set(group.map((subject) => subject.owner.contactId)),
						],
					})
					const deferred = await args.store.deferredConfirmations(journeyId, [
						...new Set(group.map((subject) => subject.owner.id)),
					])
					for (const subject of group) {
						// Newsletter signup/owner assignment may be weeks before birth.
						const eventMs = Date.parse(
							subject.birth?.occurredAt ?? subject.owner.occurredAt,
						)
						result.set(
							subject,
							members.has(subject.owner.contactId)
								? 'born'
								: deferred.has(subject.owner.id)
									? 'unknown' // Soft cooldown is not absence or permanent birth proof.
									: Number.isFinite(eventMs) &&
										  eventMs >= Date.parse(checkpoint.since) &&
										  checkpoint.asOf !== null &&
										  Date.parse(checkpoint.asOf) >=
												eventMs + BIRTH_FEED_GRACE_MS
										? 'missing'
										: 'unknown',
						)
					}
				}
				return result
			},
		},
	}
}
