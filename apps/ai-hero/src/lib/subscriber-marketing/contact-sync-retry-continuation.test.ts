import { expect, it, vi } from 'vitest'
import * as fc from 'effect/FastCheck'
import {
	DROVR_EVENTS_DELIVER_DELTA_EVENT,
	DROVR_EVENTS_DELIVER_RESTATE_EVENT,
	DROVR_EVENTS_DELIVER_BULK_EVENT,
	CONTACT_SYNC_RETRY_EVENT,
} from '@/inngest/events/drovr'
import {
	contactSyncRetryRequest,
	runContactSyncStragglerRetry,
} from './contact-sync-straggler-retry'
import {
	routeContactSyncRetry,
	retryOutboxSource,
	retryPaceClass,
	type RetryData,
} from './contact-sync-retry-route'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import type {
	DrovrBatchOutcome,
	DeferredDrovrEvent,
} from './drovr-shadow-delivery'
const now = Date.parse('2032-01-01T00:00:00.000Z')
const originalClock = new Date(now - 2 * 60 * 60_000).toISOString()
const profile = (index: number): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	contactId: 'synthetic-continuation',
	journeyId: 'contact-directory',
	type: 'contact.profile.updated',
	occurredAt: new Date(now).toISOString(),
	idempotencyKey: `profile:synthetic:3:restate:${index}`,
	payload: {
		profileVersion: 3,
		email: 'learner@example.test',
		firstName: null,
		holds: [],
	},
})
const items: DeferredDrovrEvent[] = [0, 1, 2].map((index) => ({
	event: profile(index),
	reason: 'event-not-live',
}))
const ack = { contactId: 'synthetic-continuation', profileVersion: 3 }
async function slices(answer: (event: DrovrShadowEvent) => DrovrBatchOutcome) {
	let data: RetryData = {
		items,
		attempt: 7,
		firstFailedAt: originalClock,
		acknowledge: ack,
		paceClass: 'restate',
		deliverySource: 'contact-profile-restate',
	}
	const sent: any[] = []
	const receipts: any[] = []
	const posts: DrovrShadowEvent[] = []
	const acknowledge = vi.fn(async () => {})
	for (let hop = 0; hop < 3; hop++) {
		const priorAckCount = acknowledge.mock.calls.length
		const receipt = await runContactSyncStragglerRetry({
			event: { data },
			step: {
				run: async (_id, fn) => fn(),
				sendEvent: async (_id, event) => {
					sent.push(event)
				},
			},
			runId: `slice-${hop}`,
			now: () => now,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			deliver: async (events) => {
				posts.push(...events)
				return answer(events[0]!)
			},
			birth: async () => {},
			warn: vi.fn(),
			acknowledge,
		})
		receipts.push(receipt)
		expect(posts).toHaveLength(hop + 1)
		if (hop < 2) {
			expect(receipt.status).toBe('continued')
			expect(acknowledge.mock.calls).toHaveLength(priorAckCount)
			const next = sent[sent.length - 1]
			expect(next.name).toBe(DROVR_EVENTS_DELIVER_RESTATE_EVENT)
			expect(next.data.events).toEqual([])
			expect(next.data.stragglerRetry).toBeDefined()
			data = next.data.stragglerRetry
			expect(data.firstFailedAt).toBe(originalClock)
			expect(data.attempt).toBe(7)
			expect(data.acknowledge).toEqual(ack)
		}
	}
	expect(posts).toEqual(items.map((item) => item.event))
	return { sent, receipts, acknowledge }
}
it('never acknowledges accepted=0/outboxed=1 as durable receiver acceptance', async () => {
	const acknowledge = vi.fn(async () => {})
	const pacedDeliver = vi.fn(async () => ({
		accepted: 0,
		rejected: 0,
		outboxed: 1,
	}))
	const receipt = await runContactSyncStragglerRetry({
		event: {
			data: {
				items: [items[0]!],
				attempt: 1,
				firstFailedAt: originalClock,
				acknowledge: ack,
				paceClass: 'delta',
				deliverySource: 'contact-profile-sync',
			},
		},
		step: { run: async (_id, fn) => fn(), sendEvent: vi.fn(async () => {}) },
		runId: 'synthetic-outboxed-not-accepted',
		now: () => now,
		env: { AIH_DROVR_PROFILE_SYNC: 'true' },
		pacedDeliver,
		deliver: vi.fn(async () => ({ accepted: 1, rejected: 0 })),
		birth: async () => {},
		warn: vi.fn(),
		acknowledge,
		holdBatch: vi.fn(async () => {}),
	})
	expect(pacedDeliver).toHaveBeenCalledOnce()
	expect(acknowledge).not.toHaveBeenCalled()
	expect(receipt.status).toBe('held')
})
it('property: profile acknowledgement requires acceptance of every logical member, never a deferred/outboxed/zero-proof member', async () => {
	const counts = fc.record({
		accepted: fc.integer({ min: 0, max: 1 }),
		rejected: fc.integer({ min: 0, max: 1 }),
		deferred: fc.boolean(),
		outboxed: fc.integer({ min: 0, max: 1 }),
	})
	await fc.assert(
		fc.asyncProperty(
			fc.array(counts, { minLength: 1, maxLength: 5 }),
			async (members) => {
				const logicalItems = members.map((_, index) => ({
					event: profile(index),
					reason: 'event-not-live' as const,
				}))
				let data: RetryData = {
					items: logicalItems,
					attempt: 1,
					firstFailedAt: originalClock,
					acknowledge: ack,
					paceClass: 'delta',
					deliverySource: 'contact-profile-sync',
				}
				const acknowledge = vi.fn(async () => {})
				const published: any[] = []
				const holdBatch = vi.fn(async () => {})
				for (let hop = 0; hop < members.length; hop++) {
					const answer = members[hop]!
					const receipt = await runContactSyncStragglerRetry({
						event: { data },
						step: {
							run: async (_id, fn) => fn(),
							sendEvent: async (_id, event) => {
								published.push(event)
							},
						},
						runId: `synthetic-property-${hop}`,
						now: () => now,
						env: { AIH_DROVR_PROFILE_SYNC: 'true' },
						pacedDeliver: async (_id, events) => ({
							accepted: answer.accepted,
							rejected: answer.rejected,
							outboxed: answer.outboxed,
							...(answer.deferred
								? {
										deferred: [
											{ event: events[0]!, reason: 'event-not-live' as const },
										],
									}
								: {}),
						}),
						deliver: vi.fn(async () => ({ accepted: 1, rejected: 0 })),
						birth: async () => {},
						warn: vi.fn(),
						acknowledge,
						holdBatch,
					})
					if (receipt.status !== 'continued') break
					data = published[published.length - 1].data.stragglerRetry
				}
				const allAccepted = members.every(
					(member) =>
						member.accepted === 1 &&
						member.rejected === 0 &&
						!member.deferred &&
						member.outboxed === 0,
				)
				expect(acknowledge.mock.calls.length).toBe(Number(allAccepted))
				if (holdBatch.mock.calls.length)
					expect(acknowledge).not.toHaveBeenCalled()
			},
		),
		{ numRuns: 250, seed: 428 },
	)
})
it.each(['birth-outboxed', 'birth-held', 'redelivery-outboxed'] as const)(
	'parks %s before acknowledgement/refresh or another original POST',
	async (mode) => {
		const item: DeferredDrovrEvent = {
			...items[0]!,
			reason: 'cold-start-unhandled',
		}
		const acknowledge = vi.fn(async () => {})
		const afterProfile = vi.fn(async () => {})
		const holdBatch = vi.fn(async () => {})
		const sendEvent = vi.fn(async () => {})
		let posts = 0
		const pacedDeliver = vi.fn(
			async (_id: string, events: DrovrShadowEvent[]) =>
				++posts === 1
					? {
							accepted: 0,
							rejected: 0,
							deferred: [
								{ event: events[0]!, reason: 'cold-start-unhandled' as const },
							],
						}
					: { accepted: 0, rejected: 0, outboxed: 1 },
		)
		const pacedBirth = vi.fn(async () =>
			mode === 'birth-outboxed'
				? { accepted: 0, rejected: 0, outboxed: 1 }
				: mode === 'birth-held'
					? { accepted: 0, rejected: 0, retainedHeld: 1 }
					: { accepted: 1, rejected: 0 },
		)
		const data: RetryData = {
			items: [item],
			attempt: 1,
			firstFailedAt: originalClock,
			acknowledge: ack,
			paceClass: 'delta',
			deliverySource: 'contact-profile-sync',
		}
		const receipt = await runContactSyncStragglerRetry({
			event: { data },
			step: { run: async (_id, fn) => fn(), sendEvent },
			runId: `synthetic-${mode}`,
			now: () => now,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			pacedDeliver,
			pacedBirth,
			deliver: vi.fn(async () => ({ accepted: 1, rejected: 0 })),
			birth: async () => {},
			warn: vi.fn(),
			acknowledge,
			afterProfile,
			holdBatch,
		})
		expect(receipt.status).toBe('held')
		expect(pacedDeliver).toHaveBeenCalledTimes(
			mode === 'redelivery-outboxed' ? 2 : 1,
		)
		expect(acknowledge).not.toHaveBeenCalled()
		expect(afterProfile).not.toHaveBeenCalled()
		expect(sendEvent).not.toHaveBeenCalled()
		expect(holdBatch).toHaveBeenCalledWith(
			expect.objectContaining({
				anchor: item.event,
				data: expect.objectContaining({
					items: [item],
					acknowledge: ack,
					firstFailedAt: originalClock,
				}),
			}),
		)
	},
)
it('a retained terminal rejection closes the retry member without a new HTTP rejection, handoff or profile acknowledgement', async () => {
	const acknowledge = vi.fn(async () => {})
	const sendEvent = vi.fn(async () => {})
	const receipt = await runContactSyncStragglerRetry({
		event: {
			data: {
				items: [items[0]!],
				attempt: 1,
				acknowledge: ack,
				deliverySource: 'contact-profile-sync',
			},
		},
		step: { run: async (_id, fn) => fn(), sendEvent },
		now: () => now,
		env: { AIH_DROVR_PROFILE_SYNC: 'true' },
		pacedDeliver: async () => ({
			accepted: 0,
			rejected: 0,
			retainedRejected: 1,
		}),
		deliver: async () => ({ accepted: 1, rejected: 0 }),
		birth: async () => {},
		warn: vi.fn(),
		acknowledge,
	})
	expect(receipt).toEqual({
		status: 'delivered',
		accepted: 0,
		rejected: 0,
		priorRejected: 1,
	})
	expect(acknowledge).not.toHaveBeenCalled()
	expect(sendEvent).not.toHaveBeenCalled()
})
it('one-item durable continuations retain every member/clock and acknowledge only the complete logical batch', async () => {
	const before = JSON.stringify(items)
	const result = await slices(() => ({ accepted: 1, rejected: 0 }))
	expect(result.receipts.map((receipt) => receipt.status)).toEqual([
		'continued',
		'continued',
		'delivered',
	])
	expect(result.acknowledge).toHaveBeenCalledOnce()
	expect(result.acknowledge).toHaveBeenCalledWith(
		ack.contactId,
		ack.profileVersion,
	)
	expect(new Set(result.sent.map((event) => event.id)).size).toBe(2)
	expect(JSON.stringify(items)).toBe(before)
})
it('retains earlier deferrals across slices and advances the refusal attempt only after the complete pass', async () => {
	const result = await slices((event) =>
		event.idempotencyKey.endsWith(':1')
			? { accepted: 1, rejected: 0 }
			: {
					accepted: 0,
					rejected: 0,
					deferred: [{ event, reason: 'event-not-live' }],
				},
	)
	expect(result.acknowledge).not.toHaveBeenCalled()
	expect(result.receipts[2]).toEqual({
		status: 'rescheduled',
		deferred: 2,
		attempt: 8,
	})
	const last = result.sent[result.sent.length - 1]
	expect(last.ts).toBe(now + 2 * 60 * 60_000)
	expect(last.data.stragglerRetry).toMatchObject({
		items: [items[0], items[2]],
		attempt: 8,
		firstFailedAt: originalClock,
		acknowledge: ack,
	})
	expect(last.data.stragglerRetry.carry).toBeUndefined()
})
it('retains rejection proof so a successful final slice cannot acknowledge a partially rejected version', async () => {
	const result = await slices((event) => ({
		accepted: Number(!event.idempotencyKey.endsWith(':0')),
		rejected: Number(event.idempotencyKey.endsWith(':0')),
	}))
	expect(result.sent[0].data.stragglerRetry.rejectedCarry).toBe(1)
	expect(result.sent[1].data.stragglerRetry.rejectedCarry).toBe(1)
	expect(result.receipts[2].priorRejected).toBe(1)
	expect(result.acknowledge).not.toHaveBeenCalled()
})
it('routes unknown legacy native retry work conservatively, never borrowing delta capacity or the profile-only guard', () => {
	const native = {
		...profile(0),
		type: 'contact.unsubscribed',
		payload: undefined,
	} as DrovrShadowEvent
	const request = contactSyncRetryRequest(
		[{ event: native, reason: 'event-not-live' }],
		1,
		now,
		undefined,
		undefined,
		originalClock,
	)
	expect(retryPaceClass(request.data)).toBe('backfill')
	expect(retryOutboxSource(request.data)).toBe('bulkEvergreen')
	expect(routeContactSyncRetry(request)).toMatchObject({
		name: DROVR_EVENTS_DELIVER_BULK_EVENT,
		data: { source: 'evergreen-pitch-backfill' },
	})
})
it.each(['kit-directory-ingest', 'evergreen-pitch-backfill'] as const)(
	'a paused profile producer cannot pause the unrelated %s retry worker',
	async (deliverySource) => {
		const item = {
			event: {
				...profile(0),
				type: 'contact.unsubscribed',
				payload: undefined,
			} as DrovrShadowEvent,
			reason: 'event-not-live' as const,
		}
		const deliver = vi.fn(async () => ({ accepted: 1, rejected: 0 }))
		const sendEvent = vi.fn(async () => {})
		const receipt = await runContactSyncStragglerRetry({
			event: {
				data: {
					items: [item],
					attempt: 1,
					deliverySource,
					paceClass:
						deliverySource === 'kit-directory-ingest' ? 'ingest' : 'backfill',
					firstFailedAt: originalClock,
				},
			},
			step: { run: async (_id, fn) => fn(), sendEvent },
			runId: 'synthetic-native-paused',
			now: () => now,
			env: { AIH_DROVR_PROFILE_SYNC: 'false' },
			deliver,
			birth: async () => {},
			warn: vi.fn(),
			acknowledge: vi.fn(),
		})
		expect(receipt.status).toBe('delivered')
		expect(deliver).toHaveBeenCalledOnce()
		expect(sendEvent).not.toHaveBeenCalled()
	},
)
it('routes new capped refusals directly to protected workers, not behind the shared legacy retry queue', () => {
	const request = contactSyncRetryRequest(
		items,
		1,
		now,
		ack,
		'delta',
		originalClock,
		'contact-profile-sync',
	)
	const queued = routeContactSyncRetry(request)
	expect(queued.name).toBe(DROVR_EVENTS_DELIVER_DELTA_EVENT)
	expect(queued.name).not.toBe(CONTACT_SYNC_RETRY_EVENT)
	expect(queued.data).toMatchObject({
		source: 'contact-profile-sync',
		events: [],
		stragglerRetry: request.data,
	})
	expect(queued.id).not.toBe(request.id) // global event-id dedupe must not swallow legacy routing
})
it('keeps native evergreen retries capped but distinct from guarded profile backfill', () => {
	const data: RetryData = {
		items,
		attempt: 1,
		paceClass: 'backfill',
		deliverySource: 'evergreen-pitch-backfill',
	}
	expect(retryOutboxSource(data)).toBe('bulkEvergreen')
	expect(
		routeContactSyncRetry({
			name: CONTACT_SYNC_RETRY_EVENT,
			id: 'synthetic-native',
			ts: now,
			data,
		}),
	).toMatchObject({
		name: DROVR_EVENTS_DELIVER_BULK_EVENT,
		data: { source: 'evergreen-pitch-backfill' },
	})
	expect(
		retryOutboxSource({ ...data, deliverySource: 'contact-sync-backfill' }),
	).toBe('bulkBackfill')
	expect(retryPaceClass({ ...data, paceClass: 'delta' })).toBe('backfill')
})
it('scopes retry IDs by all events, tenant/journey/contact, source and acknowledgement', () => {
	const first = contactSyncRetryRequest(
		items,
		1,
		now,
		ack,
		'delta',
		originalClock,
		'contact-profile-sync',
	)
	const changes = [
		[
			items[0]!,
			{
				...items[1]!,
				event: { ...items[1]!.event, idempotencyKey: 'changed-middle-key' },
			},
			items[2]!,
		],
		items.map((item) => ({
			...item,
			event: { ...item.event, contactId: 'another-synthetic-contact' },
		})),
		items.map((item) => ({
			...item,
			event: { ...item.event, tenantId: 'org-aihero-shadow' as const },
		})),
	]
	for (const changed of changes)
		expect(
			contactSyncRetryRequest(
				changed,
				1,
				now,
				ack,
				'delta',
				originalClock,
				'contact-profile-sync',
			).id,
		).not.toBe(first.id)
	expect(
		contactSyncRetryRequest(
			items,
			1,
			now,
			{ ...ack, profileVersion: 4 },
			'delta',
			originalClock,
			'contact-profile-sync',
		).id,
	).not.toBe(first.id)
	expect(
		contactSyncRetryRequest(
			items,
			1,
			now,
			ack,
			'restate',
			originalClock,
			'contact-profile-restate',
		).id,
	).not.toBe(first.id)
})
it('a genuine offer retry remains live even while profile sync is paused', async () => {
	const offer: DrovrShadowEvent = {
		...profile(0),
		type: 'contact.offer.issued',
		idempotencyKey: 'offer:synthetic:coupon:3',
		payload: {
			profileVersion: 3,
			journeyId: 'evergreen-pitch',
			variables: { couponCode: 'SYNTHETIC' },
		},
	}
	const request = contactSyncRetryRequest(
		[{ event: offer, reason: 'event-not-live' }],
		1,
		now,
	)
	expect(routeContactSyncRetry(request).name).toBe(CONTACT_SYNC_RETRY_EVENT)
	const deliver = vi.fn(async () => ({ accepted: 1, rejected: 0 }))
	expect(
		(
			await runContactSyncStragglerRetry({
				event: request,
				step: { run: async (_id, fn) => fn(), sendEvent: vi.fn() },
				now: () => now,
				env: {},
				deliver,
				birth: async () => {},
				warn: vi.fn(),
				acknowledge: vi.fn(),
			})
		).status,
	).toBe('delivered')
	expect(deliver).toHaveBeenCalledOnce()
})
