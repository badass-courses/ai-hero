import { describe, expect, it, vi } from 'vitest'

import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import {
	DROVR_RELEASED_BY_STRAGGLER,
	DROVR_SETTLED_BY_STRAGGLER,
	settleOrHoldStragglerStops,
} from './drovr-outbox-contact-sync'
import { postDrovrOutboxRow } from './drovr-outbox-replay-post'
import {
	deliverBatchOrThrow,
	isNeverBornOwnerStop,
	type DrovrBatchOutcome,
} from './drovr-shadow-delivery'
import {
	deliverDrovrShadowEvent,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import {
	drovrStopVerdict,
	isHeldStopRefusal,
	type DrovrStopVerdict,
} from './drovr-stop-verdict'

/**
 * Row 204c: one drovr answer to a stop gets one behaviour on every path.
 * Each case is sent through the single post, a whole-batch answer, a batch
 * item, the replay and the straggler retry, and each path's result is read
 * back as landed, released, pending or held.
 */

const config = { ingestUrl: 'https://drovr.test/events', apiKey: 'k' }

const stop = (
	type: DrovrShadowEvent['type'],
	journeyId: DrovrShadowEvent['journeyId'],
	idempotencyKey: string,
): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId,
	type,
	occurredAt: '2026-09-30T05:00:00.000Z',
	idempotencyKey,
})

const directoryUnsubscribe = stop(
	'contact.unsubscribed',
	'contact-directory',
	'aihero:stop:unsubscribe:1',
)
const ownerUnsubscribe = stop(
	'contact.unsubscribed',
	'crash-course-evergreen-offer',
	'owner:aihero:stop:unsubscribe:1',
)
// The prod shape (Opus M1): an owner copy of a purchase on value-path.
const ownerPurchase = stop(
	'purchase.recorded',
	'value-path-skills-course',
	'owner:aihero:ai-hero:purchase.recorded:1',
)
const purchase = stop(
	'purchase.recorded',
	'value-path-skills-course',
	'aihero:ai-hero:purchase.recorded:1',
)

type Answer = { status: number | 'timeout'; problem?: Record<string, unknown> }

const problem = (slug: string, status: number) => ({
	type: `urn:drovr:problem:${slug}`,
	status,
})
const NEVER_BORN = problem('contact-never-born', 409)
const COLD_START = problem('cold-start-unhandled', 409)
const NOT_LIVE = problem('event-not-live', 409)

const CASES: [string, DrovrShadowEvent, Answer, DrovrStopVerdict][] = [
	['202', ownerPurchase, { status: 202 }, 'landed'],
	['500', ownerPurchase, { status: 500 }, 'pending'],
	['503', directoryUnsubscribe, { status: 503 }, 'pending'],
	['a timeout', ownerUnsubscribe, { status: 'timeout' }, 'pending'],
	['408', directoryUnsubscribe, { status: 408 }, 'pending'],
	['429', ownerPurchase, { status: 429 }, 'pending'],
	['429', purchase, { status: 429 }, 'pending'],
	[
		'409 event-not-live',
		purchase,
		{ status: 409, problem: NOT_LIVE },
		'pending',
	],
	// The hawk (2026-09-30): drovr says "do not retry" a cold-start, so a
	// stop off the directory is held, not retried.
	[
		'409 cold-start',
		ownerPurchase,
		{ status: 409, problem: COLD_START },
		'held',
	],
	['409 cold-start', purchase, { status: 409, problem: COLD_START }, 'held'],
	[
		'409 cold-start',
		directoryUnsubscribe,
		{ status: 409, problem: COLD_START },
		'landed',
	],
	[
		'409 never-born',
		ownerPurchase,
		{ status: 409, problem: NEVER_BORN },
		'released',
	],
	[
		'409 never-born',
		ownerUnsubscribe,
		{ status: 409, problem: NEVER_BORN },
		'released',
	],
	[
		'409 never-born',
		directoryUnsubscribe,
		{ status: 409, problem: NEVER_BORN },
		'held',
	],
	['409 never-born', purchase, { status: 409, problem: NEVER_BORN }, 'held'],
	[
		'409 never-born',
		{
			...directoryUnsubscribe,
			idempotencyKey: 'owner:aihero:stop:unsubscribe:1',
		},
		{ status: 409, problem: NEVER_BORN },
		'held',
	],
	[
		'404 contact-not-found',
		purchase,
		{ status: 404, problem: problem('contact-not-found', 404) },
		'held',
	],
	[
		'400 malformed',
		ownerPurchase,
		{ status: 400, problem: problem('malformed-event', 400) },
		'held',
	],
	[
		'401',
		directoryUnsubscribe,
		{ status: 401, problem: problem('invalid-access-token', 401) },
		'held',
	],
	[
		'422',
		ownerUnsubscribe,
		{ status: 422, problem: problem('unprocessable', 422) },
		'held',
	],
]

const fetcherFor = (answer: Answer) =>
	vi.fn(async () => {
		if (answer.status === 'timeout')
			throw new Error('The operation was aborted')
		return new Response(JSON.stringify(answer.problem ?? {}), {
			status: answer.status,
		})
	})

/** A batch 200 whose one item carries the answer. */
const itemFetcherFor = (answer: Answer) =>
	vi.fn(async () => {
		if (answer.status === 'timeout')
			throw new Error('The operation was aborted')
		const status =
			answer.status < 300
				? 'accepted'
				: answer.status >= 500
					? 'failed'
					: 'rejected'
		return new Response(
			JSON.stringify({
				accepted: status === 'accepted' ? 1 : 0,
				rejected: status === 'rejected' ? 1 : 0,
				failed: status === 'failed' ? 1 : 0,
				results: [
					{
						index: 0,
						status,
						...(answer.status >= 300
							? { detail: answer.problem ?? { status: answer.status } }
							: {}),
					},
				],
			}),
			{ status: 200 },
		)
	})

const wholeBatchFetcherFor = (answer: Answer) =>
	answer.status !== 'timeout' && answer.status < 300
		? itemFetcherFor(answer)
		: fetcherFor(answer)

const quiet = vi.fn()

const single = async (event: DrovrShadowEvent, answer: Answer) => {
	const outcome = await deliverDrovrShadowEvent({
		event,
		config,
		fetcher: fetcherFor(answer),
	})
	if (outcome.status === 'accepted') return 'landed'
	if (outcome.status === 'failed') return 'pending'
	return isNeverBornOwnerStop(event, outcome) ? 'released' : 'held'
}

/** A batch answer read as the bulk lane and the straggler do. */
const readBatch = (
	outcome: DrovrBatchOutcome,
): DrovrStopVerdict | undefined => {
	if (outcome.deferred?.length) return 'pending'
	const refusal = outcome.refused?.[0]
	if (refusal) return isHeldStopRefusal(refusal) ? 'held' : 'released'
	return outcome.accepted === 1 ? 'landed' : undefined
}

const batch = async (
	event: DrovrShadowEvent,
	fetcher: typeof fetch,
	deferNotLive = false,
) => {
	try {
		return readBatch(
			await deliverBatchOrThrow({
				events: [event],
				config,
				fetcher,
				warn: quiet,
				deferNotLive,
			}),
		)
	} catch {
		// A throw is a retry of the chunk: the stop stays owed.
		return 'pending'
	}
}

const asRow = (event: DrovrShadowEvent): DrovrOutboxRow => {
	const entry = outboxEntryForEvent(event, 'live')
	return {
		...entry,
		id: 'row-1',
		dedupeKey: drovrOutboxDedupeKey('t', entry),
		target: 't',
		status: 'pending',
		attempts: 0,
		lastStatus: null,
		lastError: null,
		firstFailedAt: '2026-09-30T05:00:00.000Z',
		nextAttemptAt: '2026-09-30T05:00:00.000Z',
		lastAttemptAt: null,
		deliveredAt: null,
		releasedAt: null,
		createdAt: '2026-09-30T05:00:00.000Z',
	}
}

const replay = async (event: DrovrShadowEvent, answer: Answer) => {
	const outcome = await postDrovrOutboxRow(asRow(event), {
		ingestUrl: config.ingestUrl,
		apiKeyFor: () => config.apiKey,
		deliver: (args) =>
			deliverDrovrShadowEvent({ ...args, fetcher: fetcherFor(answer) }),
		fanOut: async (events) => [...events],
		isNeverBornOwnerStop,
	})
	// The replay holds a rejected stop row (drovr-outbox.ts).
	return {
		delivered: 'landed',
		settled: 'released',
		failed: 'pending',
		rejected: 'held',
	}[outcome.kind]
}

const straggler = async (event: DrovrShadowEvent, answer: Answer) => {
	const hold = vi.fn(async (_entries: unknown, _reason: string) => ({
		status: 'outboxed' as const,
		count: 1,
	}))
	const settle = vi.fn(async (_entries: unknown, _note: string) => ({
		status: 'settled' as const,
		count: 1,
	}))
	let answered: DrovrBatchOutcome
	try {
		answered = await deliverBatchOrThrow({
			events: [event],
			config,
			fetcher: itemFetcherFor(answer),
			warn: quiet,
			deferNotLive: true,
		})
	} catch {
		return 'pending'
	}
	await settleOrHoldStragglerStops([event], answered, {
		hold: hold as never,
		settle: settle as never,
	})
	if (hold.mock.calls.length > 0) return 'held'
	const note = settle.mock.calls[0]?.[1]
	if (note === DROVR_RELEASED_BY_STRAGGLER) return 'released'
	if (note === DROVR_SETTLED_BY_STRAGGLER) return 'landed'
	return 'pending'
}

describe('row 204c: one stop rule on every path', () => {
	it.each(CASES)(
		'%s on %j: the same behaviour on the single post, a whole batch, a batch item, the replay and the straggler retry',
		async (_, event, answer, expected) => {
			if (answer.status !== 'timeout')
				expect(
					drovrStopVerdict(event, {
						httpStatus: answer.status,
						problem: answer.problem,
					}),
				).toBe(expected)
			expect({
				single: await single(event, answer),
				wholeBatch: await batch(event, wholeBatchFetcherFor(answer)),
				batchItem: await batch(event, itemFetcherFor(answer)),
				replay: await replay(event, answer),
				straggler: await straggler(event, answer),
			}).toEqual({
				single: expected,
				// A whole-batch 404 or 405 is a drovr with no batch ingress, not an
				// answer about the events: the chunk retries, and the replay posts
				// the stop alone and holds it there. The gate is closed throughout.
				wholeBatch: answer.status === 404 ? 'pending' : expected,
				batchItem: expected,
				replay: expected,
				straggler: expected,
			})
		},
	)

	it('reads no status as pending: a network error or a timeout', () => {
		expect(drovrStopVerdict(ownerPurchase, {})).toBe('pending')
	})

	it('leaves facts on their own rules: a 429, a 408 or a cold-start on a fact is refused, not retried', async () => {
		const fact: DrovrShadowEvent = {
			...ownerPurchase,
			type: 'contact.created',
			idempotencyKey: 'aihero:fact:1',
		}
		for (const answer of [
			{ status: 429 },
			{ status: 408 },
			{ status: 409, problem: COLD_START },
		]) {
			const outcome = await deliverDrovrShadowEvent({
				event: fact,
				config,
				fetcher: fetcherFor(answer),
			})
			expect(outcome.status).toBe('rejected')
			const answered = await deliverBatchOrThrow({
				events: [fact],
				config,
				fetcher: fetcherFor(answer),
				warn: quiet,
			})
			expect(answered).toMatchObject({ accepted: 0, rejected: 1 })
			expect(isHeldStopRefusal(answered.refused![0]!)).toBe(false)
		}
	})

	it("retries a whole chunk when any stop in it is still owed, and counts a directory stop's cold-start as landed beside a refused fact", async () => {
		const fact: DrovrShadowEvent = {
			...ownerPurchase,
			type: 'contact.created',
			idempotencyKey: 'aihero:fact:1',
		}
		await expect(
			deliverBatchOrThrow({
				events: [fact, ownerPurchase],
				config,
				fetcher: fetcherFor({ status: 429 }),
				warn: quiet,
			}),
		).rejects.toThrow('429')
		const answered = await deliverBatchOrThrow({
			events: [directoryUnsubscribe, fact],
			config,
			fetcher: fetcherFor({ status: 409, problem: COLD_START }),
			warn: quiet,
		})
		expect(answered).toMatchObject({ accepted: 1, rejected: 1 })
		expect(answered.refused?.map(({ event }) => event.idempotencyKey)).toEqual([
			'aihero:fact:1',
		])
	})

	it('on a contact-sync batch, defers a fact drovr answered cold-start but refuses a stop off the directory (the hawk: held, never retried)', async () => {
		const fact: DrovrShadowEvent = {
			...ownerPurchase,
			type: 'contact.created',
			idempotencyKey: 'aihero:fact:1',
		}
		const answered = await deliverBatchOrThrow({
			events: [fact, ownerPurchase, directoryUnsubscribe],
			config,
			fetcher: fetcherFor({ status: 409, problem: COLD_START }),
			warn: quiet,
			deferNotLive: true,
		})
		expect(answered).toMatchObject({ accepted: 1, rejected: 1 })
		expect(answered.deferred?.map(({ event }) => event.idempotencyKey)).toEqual(
			['aihero:fact:1'],
		)
		expect(answered.refused?.map(({ event }) => event.idempotencyKey)).toEqual([
			ownerPurchase.idempotencyKey,
		])
		expect(isHeldStopRefusal(answered.refused![0]!)).toBe(true)
	})

	it("carries drovr's Retry-After on a stop's 429", async () => {
		const outcome = await deliverDrovrShadowEvent({
			event: ownerPurchase,
			config,
			fetcher: vi.fn(
				async () =>
					new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
			),
		})
		expect(outcome).toMatchObject({
			status: 'failed',
			httpStatus: 429,
			retryAfterMs: 30_000,
		})
	})
})
