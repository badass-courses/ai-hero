import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retainedRetryOutcome, type OwnedRetryEvent } from '@/lib/subscriber-marketing/contact-sync-retry-owned-events'
import type { DrovrShadowEvent } from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import { drovrOutboxDedupeKey, outboxEntryForEvent, isOutboxStop, type DrovrOutboxEntry, type DrovrOutboxSource } from '@/lib/subscriber-marketing/drovr-outbox'
import { buildOwnerStopRejection, decideOwnerStopRejection, type OwnerStopRejectionInput } from '@/lib/subscriber-marketing/drovr-owner-stop-rejection'
import type { OwnerStopRejection } from '@/lib/subscriber-marketing/drovr-outbox-control'
vi.mock('@/lib/subscriber-marketing/drovr-unsubscribe-supersession', async load => ({ ...await load<typeof import('@/lib/subscriber-marketing/drovr-unsubscribe-supersession')>(), closeSupersededUnsubscribesLive: async () => new Map() }))

const mocks = vi.hoisted(() => ({
	batchStepId: vi.fn(
		(tenantId: string, chunkIndex: number) =>
			`batch:${tenantId}:${chunkIndex}`,
	),
	createFunction: vi.fn(
		(config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler: (input: any) => (handler as (input: any) => unknown)({ runId: 'synthetic-controller-root', ...input }),
		}),
	),
	deliverBatchOrThrow: vi.fn(),
	deliverOrThrow: vi.fn(),
	deliveryStepId: vi.fn(
		(event: { idempotencyKey: string }) => `deliver:${event.idempotencyKey}`,
	),
	drovrApiKeyForTenant: vi.fn(),
	fanOutOwnedEvents: vi.fn(),
	isNeverBornOwnerStop: vi.fn(),
	isShadowNewsletterBirth: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	resolveOwnedContactIds: vi.fn(),
	capture: vi.fn(),
	openStops: vi.fn(),
	settle: vi.fn(),
	hold: vi.fn(),
	valuePathBulkFreeze: vi.fn(),
	readBirthOptOuts: vi.fn(),
	pace: vi.fn(),
	clockSlot: 0,
	own: vi.fn(),
	retained: new Map<string, OwnedRetryEvent>(),
	ownerStopReceipts: new Map<string, OwnerStopRejection>(),
	recordOwnerStopRejection: vi.fn(),
	disposition: vi.fn(),
	parkBatch: vi.fn(),
	reject: vi.fn(),
	readOffer: vi.fn(),
	proofRows: vi.fn(),
	releasePermission: vi.fn(),
	completeBatch: vi.fn(),
	acknowledge: vi.fn(),
	guardAck: vi.fn(),
	completeAck: vi.fn(),
}))

// The freeze window's calendar is pinned in drovr-bulk-freeze.test.ts; here
// it is a switch, so no test here turns on the date it runs.
vi.mock('@/lib/subscriber-marketing/drovr-bulk-freeze', async (original) => ({
	...(await original<
		typeof import('@/lib/subscriber-marketing/drovr-bulk-freeze')
	>()),
	valuePathBulkFreeze: mocks.valuePathBulkFreeze,
}))

vi.mock('@/lib/subscriber-marketing/contact-sync-profile-ack-completion-live', () => ({ completeProfileAckWorkerReferenceLive: mocks.completeAck }))
vi.mock('@/lib/subscriber-marketing/contact-sync-profile-ack-admission', () => ({ guardProfileAckWorkerAdmissionLive: mocks.guardAck }))
vi.mock('@/db', () => ({ db: new Proxy({}, { get: () => { throw new Error('ControllerFixture: you queried the database, and it failed because this controller test has no database port. Accepted: explicit synthetic adapters. Fix: inject the needed fixture. Debug: inspect the unexpected query stack.') } }) }))
vi.mock('@/lib/subscriber-marketing/drovr-owner-stop-rejection-live', () => ({ recordOwnerStopRejectionLive: mocks.recordOwnerStopRejection }))
vi.mock('@/lib/subscriber-marketing/contact-sync-retry-owned-events', async original => ({ ...await original<typeof import('@/lib/subscriber-marketing/contact-sync-retry-owned-events')>(), ownRetryEvents: mocks.own, readRetryDispositionLive: mocks.disposition }))
vi.mock('@/lib/subscriber-marketing/contact-sync-held-batch-live', () => ({ parkContactSyncRetryLive: mocks.parkBatch, releasedRetryPermissionLive: mocks.releasePermission, completeContactSyncHeldBatchLive: mocks.completeBatch }))
vi.mock('@/lib/subscriber-marketing/contact-sync-held-batch-drizzle', () => ({ heldBatchRowsLive: mocks.proofRows }))
vi.mock('@/lib/subscriber-marketing/contact-profile-version-drizzle', () => ({ createDrizzleContactProfileVersionStore: () => ({ acknowledge: mocks.acknowledge }) }))
// Controller-only virtual DB clock follows its allocator exactly. Actual
// fetch containment, RTT, app skew and sliding windows have transport tests.
vi.mock('@/lib/subscriber-marketing/drovr-bulk-clock', async original => ({ ...await original<typeof import('@/lib/subscriber-marketing/drovr-bulk-clock')>(), probeDrovrBulkClock: async () => ({ utcMs: mocks.clockSlot, rttMs: 0, precisionMs: 0, monotonicAt: 0, monotonicNow: () => 0 }) }))
vi.mock('@/lib/subscriber-marketing/drovr-bulk-pace', async original => {
	const actual = await original<typeof import('@/lib/subscriber-marketing/drovr-bulk-pace')>()
	return { ...actual, waitForBulkSlot: (step: Parameters<typeof actual.waitForBulkSlot>[0], id: string, kind: Parameters<typeof actual.waitForBulkSlot>[2]) => actual.waitForBulkSlot(step, id, kind, async value => { const slot = await mocks.pace(value); mocks.clockSlot = slot; return slot }) }
})
vi.mock('@/lib/subscriber-marketing/contact-sync-offer-refresh', async original => ({ ...await original<typeof import('@/lib/subscriber-marketing/contact-sync-offer-refresh')>(), readCurrentOfferAfterProfile: mocks.readOffer }))

vi.mock('@/env.mjs', () => ({
	env: { DROVR_SHADOW_INGEST_URL: 'https://drovr.test/events' },
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-delivery', () => ({
	batchStepId: mocks.batchStepId,
	deliverBatchOrThrow: mocks.deliverBatchOrThrow,
	deliverOrThrow: mocks.deliverOrThrow,
	deliveryStepId: mocks.deliveryStepId,
	DROVR_BATCH_MAX: 100,
	isNeverBornOwnerStop: mocks.isNeverBornOwnerStop,
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-emitter', async original => ({
	...await original<typeof import('@/lib/subscriber-marketing/drovr-shadow-emitter')>(),
	drovrApiKeyForTenant: mocks.drovrApiKeyForTenant,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID: 'shadow-newsletter',
	DROVR_SHADOW_TENANT_ID: 'org-aihero-shadow',
}))
vi.mock('@/lib/subscriber-marketing/drovr-ownership', async original => ({
	...await original<typeof import('@/lib/subscriber-marketing/drovr-ownership')>(),
	fanOutOwnedEvents: mocks.fanOutOwnedEvents,
	isShadowNewsletterBirth: mocks.isShadowNewsletterBirth,
}))
vi.mock('@/lib/subscriber-marketing/drovr-ownership-live', () => ({
	resolveOwnedContactIds: mocks.resolveOwnedContactIds,
}))
vi.mock(
	'@/lib/subscriber-marketing/drovr-value-path-birth-admission-live',
	() => ({
		readUnsubscribedValuePathContactIds: mocks.readBirthOptOuts,
	}),
)
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/lib/subscriber-marketing/drovr-outbox-live', () => ({
	captureDrovrOutboxLive: mocks.capture,
	holdDrovrStopsLive: mocks.hold,
	openDrovrOutboxStopsLive: mocks.openStops,
	settleDrovrOutboxLive: mocks.settle,
	rejectDrovrOutboxLive: mocks.reject,
	drovrOutboxTargetFromEnv: () => 'synthetic-controller-target',
}))

import { contactSyncRetryRequest } from '@/lib/subscriber-marketing/contact-sync-straggler-retry'
import { routeContactSyncRetry } from '@/lib/subscriber-marketing/contact-sync-retry-route'
import type { DeferredDrovrEvent } from '@/lib/subscriber-marketing/drovr-shadow-delivery'

import {
	deliverEventNameFor,
	type DrovrDeliverySource,
} from '@/inngest/events/drovr'

import {
	DROVR_CLAMP_INSTANT_STEP,
	drovrEventsDeliver,
	drovrEventsDeliverBulk,
	drovrEventsDeliverDelta,
	drovrEventsDeliverRestate,
	drovrEventsDeliverIngest,
	inDeliveryOrder,
	outboxFailedRun,
} from './drovr-events-deliver'

/** Every delivery source; the type check below fails if one is missing. */
const DELIVERY_SOURCES = [
	'contact-created',
	'contact-event',
	'kit-webhook',
	'side-effect-intent-completed',
	'side-effect-intent-failed',
	'course-completed',
	'course-exhausted',
	'newsletter-veteran',
	'drovr-owned-signup',
	'kit-directory-ingest',
	'contact-profile-sync',
	'contact-profile-restate',
	'contact-sync-backfill',
	'evergreen-pitch-backfill',
] as const satisfies readonly DrovrDeliverySource[]
const everySourceListed: [
	Exclude<DrovrDeliverySource, (typeof DELIVERY_SOURCES)[number]>,
] extends [never]
	? true
	: false = true

type Step = {
	run: (id: string, operation: () => unknown) => Promise<unknown>
	sleepUntil: (id: string, date: Date) => Promise<unknown>
	sendEvent: (id: string, event: unknown) => Promise<unknown>
}

type Registered = {
	config: {
		id: string
		retries?: number
		onFailure?: (input: Record<string, unknown>) => Promise<unknown>
		concurrency: Array<{ key?: string; limit: number }>
		batchEvents?: { maxSize: number; timeout: string }
		throttle?: { limit: number; period: string }
	}
	trigger: { event: string }
	handler: (input: Record<string, unknown>) => Promise<unknown>
}

const registered = drovrEventsDeliver as unknown as Registered
const registeredBulk = drovrEventsDeliverBulk as unknown as Registered
const registeredDelta = drovrEventsDeliverDelta as unknown as Registered
const registeredRestate = drovrEventsDeliverRestate as unknown as Registered
const registeredIngest = drovrEventsDeliverIngest as unknown as Registered

/** Execute only immediate structural SDK handoffs, in distinct physical-run
 * step namespaces. Timed retries and derived refreshes remain queued. Parent
 * forwarding is not receiver acceptance: assertions see actual leaf outcomes. */
const runCappedTree = async (worker: Registered, input: Record<string, unknown>) => {
	const original = input.step as Step
	const pending: { worker: Registered; input: Record<string, unknown> }[] = [{ worker, input }]
	const leaves: Record<string, unknown>[] = []
	const seen = new Set<string>()
	let runs = 0
	while (pending.length) {
		if (++runs > 1024) throw new Error('ControllerFixture: structural handoff tree exceeded its bounded synthetic run budget')
		const current = pending.shift()!
		const scope = runs === 1 ? '' : `physical-${runs}:`
		let forwarded = false
		const tools: Step = {
			run: (id, operation) => original.run(`${scope}${id}`, operation),
			sleepUntil: (id, date) => original.sleepUntil(`${scope}${id}`, date),
			sendEvent: async (id, value) => {
				const receipt = await original.sendEvent(`${scope}${id}`, value)
				if (id.includes('bounded-paced-shards:') || id.endsWith('route-to-class-queue')) {
					forwarded = true
					for (const command of (Array.isArray(value) ? value : [value]) as { id?: string; name: string; data: unknown }[]) {
						const next = [registeredBulk, registeredDelta, registeredRestate, registeredIngest].find(item => item.trigger.event === command.name)
						if (!next) throw new Error('ControllerFixture: unknown structural class route')
						const key = command.id ?? JSON.stringify([command.name, command.data])
						if (!seen.has(key)) { seen.add(key); pending.push({ worker: next, input: { ...current.input, events: [command] } }) }
					}
				}
				return receipt
			},
		}
		const result = await current.worker.handler({ ...current.input, step: tools }) as Record<string, unknown>
		if (!forwarded) leaves.push(result)
	}
	if (leaves.length === 1) return leaves[0]!
	const total: Record<string, unknown> = { status: leaves.some(item => item.status !== 'skipped') ? 'delivered' : 'skipped' }
	for (const leaf of leaves) for (const [key, value] of Object.entries(leaf)) if (typeof value === 'number') total[key] = Number(total[key] ?? 0) + value
	return total
}

const event = (
	tenantId: 'org-aihero' | 'org-aihero-shadow',
	idempotencyKey: string,
	journeyId = 'value-path-skills-course',
	type = 'value-path.answer-selected',
) => ({
	tenantId,
	contactId: 'contact-1',
	journeyId,
	type,
	occurredAt: '2026-09-21T12:00:00.000Z',
	idempotencyKey,
	...(['contact.profile.updated', 'contact.links.issued', 'contact.offer.issued'].includes(type) ? { payload: { profileVersion: 1 } } : {}),
})

const createStep = (): Step => ({
	run: vi.fn(async (_id, operation) => operation()),
	sleepUntil: vi.fn(async () => undefined),
	sendEvent: vi.fn(async () => undefined),
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.guardAck.mockReset().mockResolvedValue(undefined)
	mocks.completeAck.mockReset().mockResolvedValue(undefined)
	mocks.pace.mockImplementation(async () => Date.now())
	mocks.clockSlot = 0
	mocks.retained.clear()
	mocks.ownerStopReceipts.clear()
	const identity = (item: Pick<DrovrOutboxEntry, 'tenantId' | 'contactId' | 'journeyId' | 'idempotencyKey'>) => JSON.stringify([item.tenantId, item.contactId, item.journeyId, item.idempotencyKey])
	mocks.capture.mockImplementation(async (entries: DrovrOutboxEntry[], _reason?: unknown, options?: { status?: 'deferred' }) => {
		for (const entry of entries) if (entry.endpoint === 'events') {
			if (!mocks.retained.has(identity(entry))) mocks.retained.set(identity(entry), { event: structuredClone(entry.body) as DrovrShadowEvent, clampAt: entry.firstSentAt ? Date.parse(entry.firstSentAt) : Date.now(), delivered: false, status: options?.status ?? 'pending', outboxKey: drovrOutboxDedupeKey('synthetic-controller-target', entry) })
			else if (options?.status === 'deferred' && ['pending', 'deferred'].includes(mocks.retained.get(identity(entry))!.status)) mocks.retained.get(identity(entry))!.status = 'deferred'
		}
		return { status: 'outboxed', count: entries.length }
	})
	mocks.own.mockImplementation(async (events: readonly DrovrShadowEvent[], source: DrovrOutboxSource, clampAt: number, options?: { retainedOnly?: boolean }) => {
		if (!options?.retainedOnly) {
		const receipt = await mocks.capture(events.map(item => outboxEntryForEvent(item, source, { sentAt: clampAt })), undefined, { nextAttemptAt: new Date(Date.now() + 24 * 60 * 60_000) })
		if (receipt?.status !== 'outboxed') throw new Error('RetryOwnership: you prepared capped work, and it failed because durable capture is unavailable. Accepted: immutable retained work. Fix: restore the outbox. Debug: inspect the capture receipt.')
		}
		return events.map(item => {
			const key = identity(item)
			if (options?.retainedOnly && !mocks.retained.has(key)) throw new Error('synthetic retained-only row disappeared')
			if (!mocks.retained.has(key)) mocks.retained.set(key, { event: structuredClone(item), clampAt, delivered: false, status: 'pending', outboxKey: drovrOutboxDedupeKey('synthetic-controller-target', outboxEntryForEvent(item, source)) })
			return structuredClone(mocks.retained.get(key)!)
		})
	})
	mocks.disposition.mockImplementation(async (record: OwnedRetryEvent) => {
		const current = mocks.retained.get(identity(record.event))
		if (!current) throw new Error('test scoped ownership missing')
		return retainedRetryOutcome(record, [{ key: current.outboxKey, status: current.status }])
	})
	mocks.proofRows.mockImplementation(async (target: string, keys: readonly string[]) => [...mocks.retained.values()].filter(record => keys.includes(record.outboxKey)).map(record => ({ ...outboxEntryForEvent(record.event, 'bulkDelta'), id: record.outboxKey, target, dedupeKey: record.outboxKey, status: record.status, attempts: 0, lastStatus: record.status === 'delivered' ? 202 : null, lastError: null, firstFailedAt: new Date(record.clampAt).toISOString(), nextAttemptAt: new Date(record.clampAt).toISOString(), lastAttemptAt: null, deliveredAt: record.status === 'delivered' ? new Date(record.clampAt).toISOString() : null, releasedAt: null, createdAt: new Date(record.clampAt).toISOString() })))
	mocks.releasePermission.mockImplementation(async () => { throw new Error('ControllerFixture: explicit released-permission fixture required') })
	mocks.completeBatch.mockResolvedValue(undefined)
	mocks.acknowledge.mockResolvedValue(undefined)
	mocks.readOffer.mockResolvedValue([])
	mocks.settle.mockImplementation(async (entries: { tenantId: string; contactId: string; journeyId: string; idempotencyKey: string }[]) => { for (const entry of entries) { const record = mocks.retained.get(identity(entry)); if (record && ['pending', 'deferred'].includes(record.status)) { record.delivered = true; record.status = 'delivered' } } return 1 })
	mocks.reject.mockImplementation(async (entries: DrovrOutboxEntry[]) => { for (const entry of entries) { const record = mocks.retained.get(identity(entry)); if (record && ['pending', 'deferred'].includes(record.status)) { record.status = 'rejected'; mocks.ownerStopReceipts.delete(record.outboxKey) } } })
	mocks.recordOwnerStopRejection.mockImplementation(async (input: OwnerStopRejectionInput) => {
		const receipt = buildOwnerStopRejection(input)
		await mocks.capture([input.entry], undefined, { nextAttemptAt: new Date(Date.now() + 24 * 60 * 60_000) })
		const record = mocks.retained.get(identity(input.entry))!
		if (record.status === 'delivered') return 'prior-delivered'
		if (!['pending', 'deferred', 'rejected'].includes(record.status)) throw new Error('synthetic held state forbids replacement')
		record.status = 'rejected'
		mocks.ownerStopReceipts.set(record.outboxKey, receipt)
		return 'rejected'
	})
	mocks.valuePathBulkFreeze.mockReturnValue({ frozen: false })
	mocks.openStops.mockImplementation(async (ids: readonly string[]) => [...mocks.retained.values()].filter(record => {
		const receipt = mocks.ownerStopReceipts.get(record.outboxKey)
		const proved = decideOwnerStopRejection({ ...outboxEntryForEvent(record.event, 'bulkIngest'), target: 'synthetic-controller-target', dedupeKey: record.outboxKey, status: record.status, lastStatus: receipt?.httpStatus ?? null, lastAttemptAt: receipt?.decidedAt ?? null, heldContinuation: receipt ? { v: 1, ownerStopRejection: receipt } : undefined }).exclude
		return ids.includes(record.event.contactId) && ['pending', 'deferred', 'held', 'rejected'].includes(record.status) && isOutboxStop({ eventType: record.event.type }) && !proved
	}).map(record => ({ id: record.outboxKey, contactId: record.event.contactId, journeyId: record.event.journeyId, endpoint: 'events', eventType: record.event.type, status: record.status, occurredAt: record.event.occurredAt, nextAttemptAt: new Date(record.clampAt).toISOString() })))
	mocks.readBirthOptOuts.mockResolvedValue([])
	mocks.resolveOwnedContactIds.mockResolvedValue([])
	mocks.isShadowNewsletterBirth.mockReturnValue(false)
	mocks.drovrApiKeyForTenant.mockImplementation((tenantId: string) =>
		tenantId === 'org-aihero' ? 'authority-key' : undefined,
	)
	mocks.deliverOrThrow.mockResolvedValue({ status: 'accepted' })
	mocks.isNeverBornOwnerStop.mockReturnValue(false)
	mocks.hold.mockImplementation(async (entries: unknown[]) => ({
		status: 'outboxed',
		count: entries.length,
	}))
	mocks.deliverBatchOrThrow.mockImplementation(
		({ events }: { events: unknown[] }) =>
			Promise.resolve({ accepted: events.length, rejected: 0 }),
	)
})

describe('value-path birth admission', () => {
	it.each(['live', 'bulk'])(
		'keeps active births in a mixed %s batch and never posts a recorded opt-out',
		async (lane) => {
			mocks.fanOutOwnedEvents.mockImplementation((events) => events)
			mocks.readBirthOptOuts.mockResolvedValue(['stopped'])
			const stopped = {
				...event(
					'org-aihero',
					'birth:stopped',
					'value-path-skills-course',
					'contact.created',
				),
				contactId: 'stopped',
				payload: { email: 'private@example.test' },
			}
			const active = {
				...stopped,
				contactId: 'active',
				idempotencyKey: 'birth:active',
				payload: undefined,
			}
			const data = { source: 'contact-event', events: [stopped, active] }
			const receipt =
				lane === 'live'
					? await registered.handler({ event: { data }, step: createStep() })
					: await runCappedTree(registeredBulk, {
							events: [{ data }],
							step: createStep(),
						})
			expect(receipt).toMatchObject({
				accepted: 1,
				valuePathBirthsSkippedUnsubscribed: 1,
			})
			if (lane === 'live')
				expect(
					mocks.deliverOrThrow.mock.calls.map(([args]) => args.event),
				).toEqual([active])
			else
				expect(
					mocks.deliverBatchOrThrow.mock.calls.flatMap(([args]) => args.events),
				).toEqual([active])
			expect(mocks.readBirthOptOuts.mock.calls.flatMap(([ids]) => ids)).toEqual(['stopped', 'active'])
			expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain('@')
		},
	)

	it.each(['live', 'bulk'])(
		'a same-contact orphan fact in %s is final when drovr rejects it, never retried or outboxed',
		async (lane) => {
			mocks.fanOutOwnedEvents.mockImplementation((events) => events)
			mocks.readBirthOptOuts.mockResolvedValue(['contact-1'])
			const birth = event('org-aihero', 'birth:stopped', 'value-path-skills-course', 'contact.created')
			const fact = event('org-aihero', 'orphan:answer')
			mocks.deliverOrThrow.mockResolvedValue({ status: 'rejected' })
			mocks.deliverBatchOrThrow.mockResolvedValue({ accepted: 0, rejected: 1 })
			const { step } = memoStep()
			const data = { source: 'contact-event', events: [birth, fact] }
			const run = () => lane === 'live'
				? registered.handler({ event: { data }, step })
				: runCappedTree(registeredBulk, { events: [{ data }], step })
			expect(await run()).toMatchObject({ rejected: 1, valuePathBirthsSkippedUnsubscribed: 1 })
			expect(await run()).toMatchObject({ rejected: 1, valuePathBirthsSkippedUnsubscribed: 1 })
			const posted = lane === 'live'
				? mocks.deliverOrThrow.mock.calls.map(([args]) => args.event)
				: mocks.deliverBatchOrThrow.mock.calls.flatMap(([args]) => args.events)
			expect(posted).toEqual([fact])
			if (lane === 'live') expect(mocks.capture).not.toHaveBeenCalled()
			else {
				expect(mocks.capture).toHaveBeenCalledOnce()
				expect(mocks.capture).toHaveBeenCalledWith([expect.objectContaining({ body: fact, needsFanOut: false, source: 'bulkEvergreen' })], undefined, expect.objectContaining({ nextAttemptAt: expect.any(Date) }))
			}
			expect(mocks.hold).not.toHaveBeenCalled()
		},
	)

	it('fails closed when the recorded opt-out read fails', async () => {
		mocks.fanOutOwnedEvents.mockImplementation((events) => events)
		mocks.readBirthOptOuts.mockRejectedValue(new Error('read unavailable'))
		await expect(
			registered.handler({
				event: {
					data: {
						source: 'contact-event',
						events: [
							event(
								'org-aihero',
								'birth',
								'value-path-skills-course',
								'contact.created',
							),
						],
					},
				},
				step: createStep(),
			}),
		).rejects.toThrow('read unavailable')
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
	})
})

describe('drovr events deliver registration', () => {
	it('durably captures a late-listed raw parent stop before publishing even the first positive child', async () => {
		const stop = event('org-aihero', 'synthetic-late-stop', 'contact-directory', 'contact.unsubscribed')
		const positive = { ...event('org-aihero', 'synthetic-earlier-child'), occurredAt: '2026-09-21T12:00:20.000Z' }
		let persisted = false
		mocks.capture.mockImplementation(async () => { await Promise.resolve(); persisted = true; return { status: 'outboxed', count: 1 } })
		const step = createStep()
		step.sendEvent = vi.fn(async () => { expect(persisted).toBe(true) })
		await registeredBulk.handler({ events: [{ data: { source: 'evergreen-pitch-backfill', events: [positive, stop] } }], step })
		expect(mocks.capture).toHaveBeenCalledOnce()
		expect(mocks.capture.mock.calls[0]![0]).toEqual([expect.objectContaining({ body: stop, needsFanOut: true, source: 'bulkEvergreen' })])
		expect(step.sendEvent).toHaveBeenCalledOnce(); expect(mocks.pace).not.toHaveBeenCalled(); expect(mocks.deliverBatchOrThrow).not.toHaveBeenCalled()
	})
	it('publishes no children and books no HTTP capacity when parent-stop capture is unavailable', async () => {
		mocks.capture.mockResolvedValue({ status: 'unavailable' })
		const step = createStep()
		await expect(runCappedTree(registeredBulk, { events: [{ data: { source: 'evergreen-pitch-backfill', events: [event('org-aihero', 'synthetic-positive'), event('org-aihero', 'synthetic-stop', 'contact-directory', 'contact.unsubscribed')] } }], step })).rejects.toThrow('ParentStops:')
		expect(step.sendEvent).not.toHaveBeenCalled(); expect(mocks.pace).not.toHaveBeenCalled(); expect(mocks.deliverBatchOrThrow).not.toHaveBeenCalled()
	})
	it('memoized owner siblings with the same key on different journeys each execute their single-event transport callback', async () => {
		const original = event('org-aihero', 'synthetic-unsubscribe', 'contact-directory', 'contact.unsubscribed')
		const children = [original, { ...original, journeyId: 'value-path-skills-course', idempotencyKey: 'owner:synthetic-unsubscribe' }, { ...original, journeyId: 'crash-course-evergreen-offer', idempotencyKey: 'owner:synthetic-unsubscribe' }]
		mocks.fanOutOwnedEvents.mockReturnValue(children)
		const step = createStep(); const memo = new Map<string, Promise<unknown>>()
		step.run = vi.fn((id, operation) => { if (!memo.has(id)) memo.set(id, Promise.resolve().then(operation)); return memo.get(id)! })
		await runCappedTree(registeredBulk, { events: [{ data: { source: 'evergreen-pitch-backfill', events: [original] } }], step })
		expect(mocks.deliverBatchOrThrow.mock.calls.map(([input]) => input.events[0])).toEqual(children)
		expect(mocks.pace).toHaveBeenCalledTimes(3)
	})

	it('parks an active straggler on a retained hold with its full owned carry and original clock, without booking, HTTP, refresh or ACK', async () => {
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
		try {
		mocks.fanOutOwnedEvents.mockImplementation(events => events)
		const profile = { ...event('org-aihero', 'synthetic-held-retry', 'contact-directory', 'contact.profile.updated'), journeyId: 'contact-directory' as const, type: 'contact.profile.updated' as const, payload: { profileVersion: 1, email: 'learner@example.test', firstName: null, holds: [] } }
		const link = { ...event('org-aihero', 'synthetic-held-carry', 'contact-directory', 'contact.links.issued'), journeyId: 'contact-directory' as const, type: 'contact.links.issued' as const, payload: { profileVersion: 1, journeyId: 'skills-newsletter', emailKey: 'email', issuedAt: '2032-01-01T00:00:00.000Z', expiresAt: '2032-05-01T00:00:00.000Z', variables: {}, sendTimeFields: [] } }
		const identity = JSON.stringify([profile.tenantId, profile.contactId, profile.journeyId, profile.idempotencyKey])
		const firstFailedAt = new Date(Date.now() - 60_000).toISOString()
		const profileKey = drovrOutboxDedupeKey('synthetic-controller-target', outboxEntryForEvent(profile, 'bulkDelta'))
		const linkKey = drovrOutboxDedupeKey('synthetic-controller-target', outboxEntryForEvent(link, 'bulkDelta'))
		mocks.retained.set(identity, { event: profile, clampAt: Date.parse(firstFailedAt), delivered: false, status: 'held', outboxKey: profileKey })
		const tools = createStep()
		const result = await runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [], stragglerRetry: { items: [{ event: profile, reason: 'event-not-live' }], carry: [{ event: link, reason: 'event-not-live' }], attempt: 1, firstFailedAt, acknowledge: { contactId: 'contact-1', profileVersion: 1 } } } }], step: tools })
		expect(result).toMatchObject({ status: 'held' })
		expect(mocks.parkBatch).toHaveBeenCalledWith(expect.objectContaining({ anchor: profile, data: expect.objectContaining({ firstFailedAt, ownedKeys: [profileKey, linkKey], carry: [{ event: link, reason: 'event-not-live' }] }) }))
		expect(mocks.pace).not.toHaveBeenCalled(); expect(mocks.deliverBatchOrThrow).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled(); expect(tools.sendEvent).not.toHaveBeenCalled()
		} finally { vi.unstubAllEnvs() }
	})
	it.each(['held', 'rejected'] as const)('does not book, post, refresh or settle an already %s owned profile', async status => {
		mocks.fanOutOwnedEvents.mockImplementation(events => events)
		const profile = { ...event('org-aihero', 'synthetic-retained-status', 'contact-directory', 'contact.profile.updated'), journeyId: 'contact-directory' as const, type: 'contact.profile.updated' as const, payload: { profileVersion: 1, email: 'learner@example.test', firstName: null, holds: [] } }
		const identity = JSON.stringify([profile.tenantId, profile.contactId, profile.journeyId, profile.idempotencyKey])
		mocks.retained.set(identity, { event: profile, clampAt: Date.now(), delivered: false, status, outboxKey: drovrOutboxDedupeKey('synthetic-controller-target', outboxEntryForEvent(profile, 'bulkDelta')) })
		const tools = createStep()
		const result = await runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [profile] } }], step: tools })
		expect(result).toMatchObject({ accepted: 0, rejected: 0, [status === 'held' ? 'retainedHeld' : 'retainedRejected']: 1 })
		expect(mocks.pace).not.toHaveBeenCalled(); expect(mocks.deliverBatchOrThrow).not.toHaveBeenCalled()
		expect(mocks.settle).not.toHaveBeenCalled(); expect(tools.sendEvent).not.toHaveBeenCalled()
		expect(mocks.retained.get(identity)?.status).toBe(status)
	})
	it.each(['held', 'rejected'] as const)('fresh %s protection wins over the pre-booking pending snapshot', async status => {
		mocks.fanOutOwnedEvents.mockImplementation(events => events)
		const profile = event('org-aihero', 'synthetic-wait-status', 'contact-directory', 'contact.profile.updated')
		const identity = JSON.stringify([profile.tenantId, profile.contactId, profile.journeyId, profile.idempotencyKey])
		mocks.pace.mockImplementation(async () => {
			const record = mocks.retained.get(identity)
			if (!record) throw new Error('test ownership was not captured before booking')
			record.status = status
			return Date.now()
		})
		const tools = createStep()
		const result = await runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [profile] } }], step: tools })
		expect(result).toMatchObject({ accepted: 0, rejected: 0, [status === 'held' ? 'retainedHeld' : 'retainedRejected']: 1 })
		expect(mocks.pace).toHaveBeenCalledOnce(); expect(mocks.disposition).toHaveBeenCalledTimes(2)
		expect(mocks.deliverBatchOrThrow).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled(); expect(tools.sendEvent).not.toHaveBeenCalled()
	})
	it('posts the first retained body and clock and gates its original planned time, not a newer duplicate', async () => {
		const first = { ...event('org-aihero', 'synthetic-retained-profile', 'contact-directory', 'contact.profile.updated'), journeyId: 'contact-directory' as const, type: 'contact.profile.updated' as const, occurredAt: '2032-01-01T00:00:00.000Z', payload: { profileVersion: 1, email: 'first@example.test', firstName: null, holds: [] } }
		const duplicate = { ...first, occurredAt: '2032-01-01T00:00:20.000Z', payload: { ...first.payload, email: 'changed@example.test' } }
		const firstClock = Date.parse('2032-01-01T00:00:01.000Z')
		mocks.retained.set(JSON.stringify([first.tenantId, first.contactId, first.journeyId, first.idempotencyKey]), { event: first, clampAt: firstClock, delivered: false, status: 'pending', outboxKey: drovrOutboxDedupeKey('synthetic-controller-target', outboxEntryForEvent(first, 'bulkDelta')) })
		mocks.openStops.mockResolvedValue([{ contactId: first.contactId, eventType: 'purchase.recorded', occurredAt: '2032-01-01T00:00:10.000Z', status: 'pending' }])
		mocks.fanOutOwnedEvents.mockImplementation(events => events)
		await runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [duplicate] } }], step: createStep() })
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledOnce()
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledWith(expect.objectContaining({ events: [first], clampAt: firstClock }))
	})
	it('isolates capped deltas, confirmations and ingest from the old backfill backlog', () => {
		expect(registeredDelta.trigger.event).toBe('drovr/events.deliver.delta')
		expect(registeredRestate.trigger.event).toBe('drovr/events.deliver.restate')
		expect(registeredIngest.trigger.event).toBe('drovr/events.deliver.ingest')
		expect(new Set([registered, registeredBulk, registeredDelta, registeredRestate, registeredIngest].map(worker => worker.config.id)).size).toBe(5)
	})
	it.each([[registeredDelta, 'contact-profile-sync', 'contact.profile.updated'], [registeredIngest, 'kit-directory-ingest', 'contact.created']])('shards large inputs into one-raw-event children on their own worker before taking any HTTP slots', async (worker, source, type) => {
		const registeredWorker = worker as Registered
		const events = Array.from({ length: 21 }, (_, index) => event('org-aihero', `shard-${index}`, 'contact-directory', type as string))
		const step = createStep()
		await registeredWorker.handler({ events: [{ data: { source, events } }], step })
		const shards = (step.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { name: string; data: { events: unknown[] } }[]
		expect(shards.map(shard => shard.data.events.length)).toEqual(Array(21).fill(1))
		expect(shards.flatMap(shard => shard.data.events)).toEqual(events)
		expect(shards.every(shard => shard.name === registeredWorker.trigger.event)).toBe(true)
		expect(mocks.pace).not.toHaveBeenCalled()
		expect(mocks.deliverBatchOrThrow).not.toHaveBeenCalled()
	})
	it.each(['missing-before-own', 'purged-at-booking', 'purged-during-own'])('returns terminal expired SDK evidence without POST, recapture or retry: %s', async mode => {
		const profile = event('org-aihero', 'profile:contact-1:1', 'contact-directory', 'contact.profile.updated')
		const ref = { target: 'synthetic-controller-target', endpoint: 'events' as const, tenantId: 'org-aihero' as const, contactId: 'contact-1', journeyId: 'contact-directory' as const, profileVersion: 1, coordinatorKey: '1'.repeat(64), requestId: '2'.repeat(64), request: { kind: 'delta' as const } }
		const expired = { _tag: 'AckEvidenceExpired' as const, v: 1 as const, target: ref.target, contactId: ref.contactId, profileVersion: 1, requestId: ref.requestId }
		if (mode === 'missing-before-own') mocks.guardAck.mockResolvedValue(expired)
		if (mode === 'purged-during-own') mocks.guardAck.mockResolvedValueOnce(undefined).mockResolvedValue(expired)
		if (mode === 'purged-at-booking') {
			await mocks.capture([outboxEntryForEvent(profile as DrovrShadowEvent, 'bulkDelta')])
			mocks.capture.mockClear()
			mocks.pace.mockImplementation(async () => { mocks.guardAck.mockResolvedValue(expired); return Date.now() })
		}
		const step = createStep()
		const result = await runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [profile], profileAckRef: ref, firstFailedAt: profile.occurredAt } }], step, attempt: 0, maxAttempts: 9 })
		expect(result).toMatchObject({ status: 'skipped', reason: 'AckEvidenceExpired', ackEvidenceExpired: expired })
		await outboxFailedRun({ source: 'contact-profile-sync', events: [profile as DrovrShadowEvent], profileAckRef: ref }, new Error('synthetic delayed failure hook'), mocks.capture)
		expect(mocks.deliverBatchOrThrow).not.toHaveBeenCalled()
		expect(mocks.capture).not.toHaveBeenCalled()
		expect(mocks.fanOutOwnedEvents).not.toHaveBeenCalled()
		expect(mocks.settle).not.toHaveBeenCalled()
		expect(mocks.acknowledge).not.toHaveBeenCalled()
		expect(step.sendEvent).not.toHaveBeenCalled()
		if (mode === 'missing-before-own') { expect(mocks.own).not.toHaveBeenCalled(); expect(mocks.pace).not.toHaveBeenCalled() }
		if (mode === 'purged-at-booking') expect([...mocks.retained.values()].every(row => row.status === 'pending')).toBe(true)
	})
	it('a pointer-free completed or OFF-then-ON retained member uses fresh SDK completion without a new POST or native rewrite', async () => {
		const profile = event('org-aihero', 'profile:contact-1:1', 'contact-directory', 'contact.profile.updated') as DrovrShadowEvent
		const ref = { target: 'synthetic-controller-target', endpoint: 'events' as const, tenantId: 'org-aihero' as const, contactId: 'contact-1', journeyId: 'contact-directory' as const, profileVersion: 1, coordinatorKey: '1'.repeat(64), requestId: '2'.repeat(64), request: { kind: 'delta' as const } }
		const entry = outboxEntryForEvent(profile, 'bulkDelta')
		await mocks.capture([entry]); await mocks.settle([entry]); mocks.capture.mockClear(); mocks.settle.mockClear()
		const result = await runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [profile], profileAckRef: ref, firstFailedAt: profile.occurredAt } }], step: createStep(), attempt: 0, maxAttempts: 9 })
		expect(result).toMatchObject({ status: 'delivered', accepted: 0, rejected: 0 })
		expect(mocks.completeAck).toHaveBeenCalledOnce()
		expect(mocks.completeAck).toHaveBeenCalledWith(ref)
		for (const port of [mocks.capture, mocks.settle, mocks.deliverBatchOrThrow, mocks.acknowledge, mocks.pace]) expect(port).not.toHaveBeenCalled()
	})
	it('settles pre-captured profile and link rows by key on the first attempt, and skips a row already delivered by replay', async () => {
		mocks.fanOutOwnedEvents.mockImplementation(events => events)
		const profile = event('org-aihero', 'profile:contact-1:1', 'contact-directory', 'contact.profile.updated')
		const link = event('org-aihero', 'links:contact-1:journey:email:v1', 'contact-directory', 'contact.links.issued')
		const run = () => runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [profile, link] } }], step: createStep(), attempt: 0, maxAttempts: 9 })
		await run()
		for (const item of [profile, link]) expect(mocks.settle).toHaveBeenCalledWith([expect.objectContaining({ idempotencyKey: item.idempotencyKey })], 'delivered by an Inngest retry', { receiverAccepted: true })
		mocks.deliverBatchOrThrow.mockClear()
		mocks.disposition.mockResolvedValue({ accepted: 0, rejected: 0, alreadyDelivered: true })
		await run()
		expect(mocks.deliverBatchOrThrow).not.toHaveBeenCalled()
	})
	it('rechecks delivery after a durable wait, so a winning replay is not posted again', async () => {
		mocks.fanOutOwnedEvents.mockImplementation(events => events)
		const profile = event('org-aihero', 'profile:contact-1:1', 'contact-directory', 'contact.profile.updated')
		mocks.disposition.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ accepted: 0, rejected: 0, alreadyDelivered: true })
		const tools = createStep()
		await runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [profile] } }], step: tools })
		expect(mocks.deliverBatchOrThrow).not.toHaveBeenCalled()
		expect(tools.sendEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ data: expect.objectContaining({ offerRefresh: { contactId: 'contact-1', profileVersion: 1 } }) }))
	})
	it('refreshes the newest offer only after the profile POST lands, on the same capped class', async () => {
		mocks.fanOutOwnedEvents.mockImplementation(events => events)
		const profile = event('org-aihero', 'profile:contact-1:1', 'contact-directory', 'contact.profile.updated')
		const tools = createStep()
		await runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [profile] } }], step: tools })
		const calls = (tools.sendEvent as ReturnType<typeof vi.fn>).mock.calls
		const refresh = calls[0]![1]
		expect(refresh).toMatchObject({ name: 'drovr/events.deliver.delta', data: { source: 'contact-profile-sync', events: [], offerRefresh: { contactId: 'contact-1', profileVersion: 1 } } })
		expect((tools.sendEvent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeGreaterThan(mocks.deliverBatchOrThrow.mock.invocationCallOrder[0]!)
		const offer = event('org-aihero', 'offer:contact-1:coupon-new:v1', 'offer', 'contact.offer.issued')
		mocks.readOffer.mockResolvedValue([offer])
		await runCappedTree(registeredDelta, { events: [refresh], step: createStep() })
		expect(mocks.deliverBatchOrThrow).toHaveBeenLastCalledWith(expect.objectContaining({ events: [offer] }))
		expect(mocks.pace.mock.calls.map(([kind]) => kind)).toEqual(['delta', 'delta'])
	})
	it('does not settle deferred profiles or queue a refresh before they land', async () => {
		mocks.fanOutOwnedEvents.mockImplementation(events => events)
		const profile = event('org-aihero', 'profile:contact-1:1', 'contact-directory', 'contact.profile.updated')
		mocks.deliverBatchOrThrow.mockResolvedValue({ accepted: 0, rejected: 0, deferred: [{ event: profile, reason: 'event-not-live' }] })
		const tools = createStep()
		await runCappedTree(registeredDelta, { events: [{ data: { source: 'contact-profile-sync', events: [profile] } }], step: tools })
		expect(mocks.settle).not.toHaveBeenCalled()
		const sends = (tools.sendEvent as ReturnType<typeof vi.fn>).mock.calls.map(([, value]) => value)
		expect(sends.some(value => value.data?.offerRefresh)).toBe(false)
		expect(sends).toContainEqual(expect.objectContaining({ name: 'drovr/events.deliver.delta', data: expect.objectContaining({ source: 'contact-profile-sync', stragglerRetry: expect.objectContaining({ paceClass: 'delta' }) }) }))
	})

	it('reserves once per actual profile/link/offer event, with the profile first', async () => {
		mocks.fanOutOwnedEvents.mockImplementation((events) => events)
		const events = ['contact.profile.updated', 'contact.links.issued', 'contact.offer.issued'].map((type, i) => event('org-aihero', `delta-${i}`, 'contact-directory', type))
		await runCappedTree(registeredBulk, { events: [{ data: { source: 'contact-profile-sync', events } }], step: createStep() })
		expect(mocks.pace).toHaveBeenCalledTimes(3)
		expect(mocks.deliverBatchOrThrow.mock.calls.map(([args]) => args.events)).toEqual(events.map(event => [event]))
	})

	it('coupon completions never acquire a saturated bulk reservation', async () => {
		mocks.pace.mockRejectedValue(new Error('bulk saturated'))
		mocks.fanOutOwnedEvents.mockImplementation((events) => events)
		const receipt = await registered.handler({ event: { data: { source: 'side-effect-intent-completed', events: [event('org-aihero', 'coupon-complete', 'offer', 'coupon.issued')] } }, step: createStep() })
		expect(receipt).toMatchObject({ status: 'delivered', accepted: 1 })
		expect(mocks.pace).not.toHaveBeenCalled()
	})

	it('isolates bulk profiles from live facts and coupon completions', () => {
		expect(everySourceListed).toBe(true)
		const bulk = DELIVERY_SOURCES.filter(
			(source) => deliverEventNameFor(source) === 'drovr/events.deliver.bulk',
		)
		expect(bulk).toEqual(['contact-sync-backfill', 'evergreen-pitch-backfill'])
		expect(deliverEventNameFor('contact-profile-sync')).toBe('drovr/events.deliver.delta')
		expect(deliverEventNameFor('contact-profile-restate')).toBe('drovr/events.deliver.restate')
		expect(deliverEventNameFor('kit-directory-ingest')).toBe('drovr/events.deliver.ingest')
		// Signups, Kit webhooks (a DOI confirm, an unsubscribe), captured
		// purchases and every other live fact go to the live function, which
		// has its own queue and no throttle, so a running backfill of any
		// size waits alone. Inngest throttles per function.
		expect(registered.trigger).toEqual({ event: 'drovr/events.deliver' })
		expect(registered.config.throttle).toBeUndefined()
	})

	it('spaces envelope starts; the shared send-time gate counts actual events', () => {
		expect(registeredBulk.config.throttle).toEqual({ limit: 1, period: '12s' })
		expect(registeredBulk.config.batchEvents!.maxSize).toBe(1)
		expect(registered.config.throttle).toBeUndefined()
	})

	it('keeps live and bulk work on their existing isolated queues', () => {
		expect(registered.config).toMatchObject({
			id: 'drovr-events-deliver-v1',
			concurrency: [{ limit: 8 }],
		})
		expect(registered.trigger).toEqual({ event: 'drovr/events.deliver' })
		expect(registeredBulk.config).toMatchObject({
			id: 'drovr-events-deliver-bulk-v1',
			concurrency: [{ limit: 4 }],
			batchEvents: { maxSize: 1, timeout: '1s' },
		})
		expect(registeredBulk.trigger).toEqual({
			event: 'drovr/events.deliver.bulk',
		})
	})
})

describe('retired shadow tenant delivery', () => {
	it('fails the owner step when the ownership read fails, so Inngest retries it and delivers nothing partial', async () => {
		mocks.resolveOwnedContactIds.mockRejectedValue(
			new Error('Vitess: connection reset'),
		)
		const stop = event(
			'org-aihero-shadow',
			'stop:contact-1',
			'value-path-skills-course',
			'contact.unsubscribed',
		)

		await expect(
			registered.handler({
				event: { data: { source: 'contact-event', events: [stop] } },
				step: createStep(),
			}),
		).rejects.toThrow('Vitess: connection reset')
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
	})

	it('delivers every authority fact unchanged and discards the shadow group', async () => {
		const shadowBirth = event(
			'org-aihero-shadow',
			'aihero:legacy:birth',
			'value-path-skills-course',
			'contact.created',
		)
		const authorityEvents = [
			event('org-aihero', 'owner:answer'),
			event(
				'org-aihero',
				'owner:birth',
				'value-path-skills-course',
				'contact.created',
			),
			event(
				'org-aihero',
				'completion:intent-key',
				'crash-course-evergreen-offer',
				'email.completed',
			),
			event(
				'org-aihero',
				'owner:newsletter-birth',
				'shadow-newsletter',
				'contact.created',
			),
		]
		mocks.fanOutOwnedEvents.mockReturnValue([
			shadowBirth,
			...authorityEvents,
		])

		const receipt = await registered.handler({
			event: { data: { source: 'live-contact', events: [shadowBirth] } },
			step: createStep(),
		})

		expect(receipt).toEqual({
			status: 'delivered',
			accepted: authorityEvents.length,
			rejected: 0,
			discarded: 1,
		})
		// One instant: the births go first (row 204b's delivery order).
		const [answer, birth, completion, newsletterBirth] = authorityEvents
		expect(mocks.deliverOrThrow.mock.calls.map(([args]) => args.event)).toEqual(
			[birth, newsletterBirth, answer, completion],
		)
		expect(mocks.log.info).toHaveBeenCalledOnce()
		expect(mocks.log.info).toHaveBeenCalledWith(
			'drovr.shadow.events_discarded',
			{
				tenantId: 'org-aihero-shadow',
				count: 1,
				deliveryLane: 'live',
			},
		)
	})

	it('never delivers an event about a synthetic principal, on either lane', async () => {
		const real = event('org-aihero', 'owner:answer')
		const synthetic = { ...event('org-aihero', 'owner:synthetic'), contactId: 'synthetic_run-1' }
		mocks.fanOutOwnedEvents.mockImplementation(events => events)

		const live = await registered.handler({
			event: { data: { source: 'live-contact', events: [synthetic, real] } },
			step: createStep(),
		})
		expect(live).toMatchObject({ accepted: 1, discarded: 1 })
		expect(mocks.deliverOrThrow.mock.calls.map(([args]) => args.event)).toEqual([real])
		expect(mocks.log.info).toHaveBeenCalledWith('drovr.shadow.synthetic_discarded', {
			count: 1,
			deliveryLane: 'live',
		})

		const bulk = await runCappedTree(registeredBulk, {
			events: [{ data: { events: [synthetic, real] } }],
			step: createStep(),
		})
		expect(bulk).toMatchObject({ discarded: 1 })
		expect(mocks.deliverBatchOrThrow).toHaveBeenLastCalledWith(
			expect.objectContaining({ events: [real] }),
		)
	})

	it('never turns a legacy shadow birth into an authority birth', async () => {
		const legacyBirth = event(
			'org-aihero-shadow',
			'aihero:legacy:birth',
			'value-path-skills-course',
			'contact.created',
		)
		mocks.fanOutOwnedEvents.mockReturnValue([legacyBirth])

		const receipt = await registered.handler({
			event: { data: { source: 'live-contact', events: [legacyBirth] } },
			step: createStep(),
		})

		expect(receipt).toMatchObject({ accepted: 0, rejected: 0, discarded: 1 })
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
	})

	it('counts each shadow input once across bounded physical runs', async () => {
		const shadowEvents = [
			event('org-aihero-shadow', 'shadow:1'),
			event('org-aihero-shadow', 'shadow:2'),
		]
		const authorityEvents = [
			event('org-aihero', 'directory:seed:contact-1', 'contact-directory'),
			event(
				'org-aihero',
				'owner:newsletter-birth',
				'shadow-newsletter',
				'contact.created',
			),
		]
		mocks.fanOutOwnedEvents.mockImplementation((items: DrovrShadowEvent[]) => items.flatMap(item => [item, authorityEvents[shadowEvents.findIndex(shadow => shadow.idempotencyKey === item.idempotencyKey)]!]))

		const receipt = await runCappedTree(registeredBulk, {
			events: [{ data: { events: shadowEvents } }],
			step: createStep(),
		})

		expect(receipt).toEqual({
			status: 'delivered',
			accepted: 2,
			rejected: 0,
			discarded: 2,
		})
		expect(mocks.deliverBatchOrThrow.mock.calls.flatMap(([args]) => args.events)).toEqual(expect.arrayContaining(authorityEvents))
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledTimes(2)
		const drops = mocks.log.info.mock.calls.filter(([tag]) => tag === 'drovr.shadow.events_discarded')
		expect(drops).toHaveLength(2)
		for (const [, detail] of drops) expect(detail).toEqual({ tenantId: 'org-aihero-shadow', count: 1, deliveryLane: 'bulk' })
	})
})

describe('row 201g: the bulk lane refuses value-path births in the 201e window', () => {
	const valuePathBirth = event(
		'org-aihero',
		'owner:birth:contact-1',
		'value-path-skills-course',
		'contact.created',
	)
	const directoryBirth = {
		...event(
			'org-aihero',
			'directory:seed:contact-2',
			'contact-directory',
			'contact.created',
		),
		contactId: 'contact-2',
	}
	const run = () =>
		runCappedTree(registeredBulk, {
			events: [
				{
					data: {
						events: [valuePathBirth, directoryBirth],
						source: 'kit-directory-ingest',
					},
				},
			],
			step: createStep(),
		})

	beforeEach(() => {
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
	})

	it('refuses them without a sign-off, loudly, and still delivers the rest', async () => {
		mocks.valuePathBulkFreeze.mockReturnValue({
			frozen: true,
			reason: 'AIH_DROVR_VALUE_PATH_BULK_FREEZE is on',
		})
		const receipt = await run()
		const sent = mocks.deliverBatchOrThrow.mock.calls.flatMap(([args]) =>
			(args as { events: { idempotencyKey: string }[] }).events.map(
				(e) => e.idempotencyKey,
			),
		)
		expect(sent).toEqual(['directory:seed:contact-2'])
		expect(receipt).toMatchObject({ accepted: 1, valuePathBirthsRefused: 1 })
		expect(mocks.log.error).toHaveBeenCalledWith(
			'drovr.bulk.value_path_births_refused',
			{
				count: 1,
				reason: 'AIH_DROVR_VALUE_PATH_BULK_FREEZE is on',
				idempotencyKeys: ['owner:birth:contact-1'],
			},
		)
	})

	it("lets them through with the hawk's sign-off, and records who signed", async () => {
		mocks.valuePathBulkFreeze.mockReturnValue({
			frozen: false,
			signedOffBy: 'hawk 2026-10-20',
		})
		const receipt = await run()
		expect(receipt).toMatchObject({ accepted: 2 })
		expect(receipt).not.toHaveProperty('valuePathBirthsRefused')
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'drovr.bulk.value_path_births_signed_off',
			{ count: 1, signedOffBy: 'hawk 2026-10-20' },
		)
	})

	it('refuses nothing outside the window, and decides from the environment and the clock', async () => {
		const receipt = await run()
		expect(mocks.valuePathBulkFreeze).toHaveBeenCalledWith(
			process.env,
			expect.any(Number),
		)
		expect(receipt).toMatchObject({ accepted: 2 })
		expect(mocks.log.error).not.toHaveBeenCalled()
	})
})

describe('contact-sync backfill batches on the bulk lane', () => {
	const backfillEvents = [
		event(
			'org-aihero',
			'profile:contact-1:v1',
			'contact-directory',
			'contact.profile.updated',
		),
	]
	const ingestEvents = [
		event('org-aihero', 'directory:seed:contact-2', 'contact-directory'),
	]

	beforeEach(() => {
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
	})

	it('drops queued backfill batches while AIH_DROVR_PROFILE_SYNC is off, keeping other bulk sources', async () => {
		// A drovr rollback turns the flag off; a page already queued must not
		// reach the old code, which burns keys without an event-not-live guard.
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', '')
		const receipt = await runCappedTree(registeredBulk, {
			events: [
				{ data: { events: backfillEvents, source: 'contact-sync-backfill' } },
				{ data: { events: ingestEvents, source: 'kit-directory-ingest' } },
			],
			step: createStep(),
		})
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledOnce()
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledWith(
			expect.objectContaining({ events: ingestEvents }),
		)
		expect(receipt).toMatchObject({ accepted: 1, backfillDropped: 1 })
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'drovr.contact_sync.backfill_dropped',
			expect.objectContaining({ count: 1 }),
		)
		vi.unstubAllEnvs()
	})

	it('delivers backfill batches while the flag is on', async () => {
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
		const receipt = await runCappedTree(registeredBulk, {
			events: [
				{ data: { events: backfillEvents, source: 'contact-sync-backfill' } },
			],
			step: createStep(),
		})
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledWith(
			expect.objectContaining({ events: backfillEvents }),
		)
		expect(receipt).toEqual({
			status: 'delivered',
			accepted: 1,
			rejected: 0,
			discarded: 0,
		})
		vi.unstubAllEnvs()
	})
})

describe('a rollback between retries of a mixed bulk run', () => {
	it('still posts the other sources when the flag goes off after a backfill chunk completed', async () => {
		// Inngest replays a completed step.run by id; model that memo.
		const memo = new Map<string, unknown>()
		const memoStep = (): Step => ({
			...createStep(),
			run: vi.fn(async (id: string, operation: () => unknown) => {
				if (memo.has(id)) return memo.get(id)
				const result = await operation()
				memo.set(id, result)
				return result
			}),
		})
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
		const backfill = Array.from({ length: 2 }, (_, index) =>
			event(
				'org-aihero',
				`profile:contact-${index}:v1`,
				'contact-directory',
				'contact.profile.updated',
			),
		)
		const ingest = [
			event('org-aihero', 'directory:seed:contact-x', 'contact-directory'),
		]
		const run = () =>
			runCappedTree(registeredBulk, {
				events: [
					{ data: { events: backfill, source: 'contact-sync-backfill' } },
					{ data: { events: ingest, source: 'kit-directory-ingest' } },
				],
				step: memoStep(),
			})
		const posted: unknown[][] = []
		let calls = 0
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: unknown[] }) => {
				calls += 1
				// The second chunk of the first attempt fails.
				if (calls === 2) throw new Error('drovr 503')
				posted.push(events)
				return { accepted: events.length, rejected: 0 }
			},
		)
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
		expect(await run()).toMatchObject({ accepted: 3 })
		const beforeRollback = posted.length
		// Replaying completed steps after a rollback never posts them again.
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', '')
		expect(await run()).toMatchObject({ accepted: 1, backfillDropped: 2 })
		vi.unstubAllEnvs()
		expect(posted).toContainEqual(ingest)
		// And no backfill event reached drovr after the flag went off.
		expect(posted).toHaveLength(beforeRollback)
	})
})

describe('backfill refusals follow the push contract (§4)', () => {
	const now = Date.parse('2026-10-01T12:00:00.000Z')
	const profileEvent = (contactId: string): DrovrShadowEvent => ({
		...event('org-aihero', `profile:${contactId}:1`, 'contact-directory', 'contact.profile.updated'),
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		payload: { profileVersion: 1, email: 'synthetic@example.test', firstName: null, holds: [] },
	})
	const [notLive, cold, fine] = [
		{ ...profileEvent('c2'), contactId: 'c2' },
		{ ...profileEvent('c3'), contactId: 'c3' },
		{ ...profileEvent('c1'), contactId: 'c1' },
	]

	it('hands refused backfill events to the straggler retry instead of throwing: event-not-live after 1 h, cold-start at once', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(now)
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
		mocks.deliverBatchOrThrow.mockImplementation(async ({ events }) => ({ accepted: events[0].idempotencyKey === fine.idempotencyKey ? 1 : 0, rejected: 0, deferred: events[0].idempotencyKey === fine.idempotencyKey ? [] : [{ event: events[0], reason: events[0].idempotencyKey === notLive.idempotencyKey ? 'event-not-live' : 'cold-start-unhandled' }] }))
		const sent: unknown[] = []
		const receipt = await runCappedTree(registeredBulk, {
			events: [
				{
					data: {
						events: [fine, notLive, cold],
						source: 'contact-sync-backfill',
					},
				},
			],
			step: {
				...createStep(),
				sendEvent: vi.fn(async (_id: string, payload: unknown) => {
					sent.push(payload)
				}),
			},
		})
		vi.useRealTimers()
		vi.unstubAllEnvs()
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledWith(
			expect.objectContaining({ deferNotLive: true }),
		)
		// Structural shards are not retries. Each physical refusal keeps its
		// protected class, first clock and the actual first-owned body.
		const retries = sent.flatMap(value => Array.isArray(value) ? value : [value]).filter((value: any) => value.data?.stragglerRetry)
		const expected = (item: DeferredDrovrEvent) => routeContactSyncRetry(contactSyncRetryRequest([item], 1, now, undefined, 'backfill', new Date(now).toISOString(), 'contact-sync-backfill'))
		expect(retries).toEqual([expected({ event: notLive, reason: 'event-not-live' }), { ...expected({ event: cold, reason: 'cold-start-unhandled' }), ts: now }])
		expect((retries[0] as { ts: number }).ts).toBe(now + 60 * 60 * 1000)
		expect(receipt).toMatchObject({ accepted: 1, deferred: 2 })
	})

	it('keeps other bulk sources on the default delivery (no deferral)', async () => {
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
		const ingest = [
			event('org-aihero', 'directory:seed:contact-z', 'contact-directory'),
		]
		await runCappedTree(registeredBulk, {
			events: [{ data: { events: ingest, source: 'kit-directory-ingest' } }],
			step: createStep(),
		})
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledWith({
			events: ingest,
			config: {
				ingestUrl: 'https://drovr.test/events',
				apiKey: 'authority-key',
			},
			clampAt: expect.any(Number),
		})
	})
})

describe('owner-copy stops drovr says never started the journey', () => {
	const neverBorn = {
		status: 'rejected',
		httpStatus: 409,
		problem: { type: 'urn:drovr:problem:contact-never-born' },
	}

	it('counts them apart from the other rejections, so the reconcile can tell', async () => {
		const directoryStop = event(
			'org-aihero',
			'aihero:contact-event:qp7rf',
			'contact-directory',
			'contact.unsubscribed',
		)
		const ownerCopy = event(
			'org-aihero',
			'owner:aihero:contact-event:qp7rf',
			'value-path-skills-course',
			'contact.unsubscribed',
		)
		mocks.fanOutOwnedEvents.mockReturnValue([directoryStop, ownerCopy])
		mocks.deliverOrThrow.mockImplementation(
			async ({ event: sent }: { event: { idempotencyKey: string } }) =>
				sent === ownerCopy ? neverBorn : { status: 'accepted' },
		)
		mocks.isNeverBornOwnerStop.mockImplementation(
			(sent: unknown, outcome: unknown) =>
				sent === ownerCopy && outcome === neverBorn,
		)

		const receipt = await registered.handler({
			event: { data: { source: 'contact-event', events: [directoryStop] } },
			step: createStep(),
		})

		expect(receipt).toEqual({
			status: 'delivered',
			accepted: 1,
			rejected: 1,
			discarded: 0,
			ownerStopsNeverBorn: 1,
		})
		expect(mocks.log.info).toHaveBeenCalledWith(
			'drovr.shadow.owner_stop_never_born',
			expect.objectContaining({
				idempotencyKey: 'owner:aihero:contact-event:qp7rf',
				journeyId: 'value-path-skills-course',
			}),
		)
	})

	it('logs each one once, however often Inngest replays the run', async () => {
		const ownerCopy = event(
			'org-aihero',
			'owner:aihero:contact-event:qp7rf',
			'value-path-skills-course',
			'contact.unsubscribed',
		)
		mocks.fanOutOwnedEvents.mockReturnValue([ownerCopy])
		mocks.deliverOrThrow.mockResolvedValue(neverBorn)
		mocks.isNeverBornOwnerStop.mockReturnValue(true)
		// Inngest memoizes a finished step: a replay gets its output back
		// without running the body again.
		const memo = new Map<string, unknown>()
		const step: Step = {
			...createStep(),
			run: vi.fn(async (id: string, operation: () => unknown) => {
				if (!memo.has(id)) memo.set(id, await operation())
				return memo.get(id)
			}),
		}
		const input = {
			event: { data: { source: 'contact-event', events: [ownerCopy] } },
			step,
		}

		const first = await registered.handler(input)
		const replay = await registered.handler(input)

		expect(replay).toEqual(first)
		expect(replay).toMatchObject({ rejected: 1, ownerStopsNeverBorn: 1 })
		expect(
			mocks.log.info.mock.calls.filter(
				([message]) => message === 'drovr.shadow.owner_stop_never_born',
			),
		).toHaveLength(1)
	})

	it('holds a refused directory stop for a human: it is the suppression authority (row 204c)', async () => {
		const directoryStop = event(
			'org-aihero',
			'aihero:contact-event:qp7rf',
			'contact-directory',
			'contact.unsubscribed',
		)
		mocks.fanOutOwnedEvents.mockReturnValue([directoryStop])
		mocks.deliverOrThrow.mockResolvedValue(neverBorn)

		const receipt = await registered.handler({
			event: { data: { source: 'contact-event', events: [directoryStop] } },
			step: createStep(),
		})

		expect(receipt).toEqual({
			status: 'delivered',
			accepted: 0,
			rejected: 0,
			discarded: 0,
			heldStops: 1,
		})
		expect(mocks.hold).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					idempotencyKey: 'aihero:contact-event:qp7rf',
				}),
			],
			expect.stringContaining('drovr refused the stop (409)'),
			409,
		)
	})
})

/** drovr's answer as DrovrDeliveryFailedError carries it. */
const drovrFailure = (httpStatus: number, retryAfterMs?: number) =>
	Object.assign(new Error(`drovr answered ${httpStatus}`), {
		name: 'DrovrDeliveryFailedError',
		httpStatus,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	})

// Inngest: retries 8 is nine attempts; attempt 8 is the last.
const LAST = { attempt: 8, maxAttempts: 9 }

describe('row 204: a drovr 5xx never loses a live or bulk event', () => {
	beforeEach(() => {
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
	})

	it('gives both drovr-send functions a retry budget of 8', () => {
		expect(registered.config.retries).toBe(8)
		expect(registeredBulk.config.retries).toBe(8)
	})

	it.each([500, 503])(
		'retries a live %i with RetryAfterError, never under the backoff table',
		async (httpStatus) => {
			// drovr asks for 5 s; the table says 60 s on the third attempt.
			mocks.deliverOrThrow.mockRejectedValue(drovrFailure(httpStatus, 5_000))
			const error = await registered
				.handler({
					event: {
						data: {
							source: 'live-contact',
							events: [event('org-aihero', 'owner:answer')],
						},
					},
					step: createStep(),
					attempt: 2,
					maxAttempts: 9,
				})
				.catch((thrown: unknown) => thrown)
			expect(error).toMatchObject({ name: 'RetryAfterError', retryAfter: '60' })
			expect(mocks.capture).not.toHaveBeenCalled()
		},
	)

	it('honours a Retry-After longer than the table, capped at 10 minutes', async () => {
		mocks.deliverOrThrow.mockRejectedValue(drovrFailure(503, 3_600_000))
		const error = await registered
			.handler({
				event: {
					data: {
						source: 'live-contact',
						events: [event('org-aihero', 'owner:answer')],
					},
				},
				step: createStep(),
				attempt: 0,
				maxAttempts: 9,
			})
			.catch((thrown: unknown) => thrown)
		expect(error).toMatchObject({ name: 'RetryAfterError', retryAfter: '600' })
	})

	it.each([500, 503])(
		'outboxes a live event on the last attempt of a %i and completes the run',
		async (httpStatus) => {
			const answer = event('org-aihero', 'owner:answer')
			const accepted = event('org-aihero', 'owner:accepted')
			mocks.deliverOrThrow.mockImplementation(
				async ({ event: sent }: { event: { idempotencyKey: string } }) => {
					if (sent.idempotencyKey === 'owner:answer')
						throw drovrFailure(httpStatus)
					return { status: 'accepted' }
				},
			)
			const receipt = await registered.handler({
				event: {
					data: { source: 'live-contact', events: [answer, accepted] },
				},
				step: createStep(),
				...LAST,
			})
			expect(receipt).toEqual({
				status: 'delivered',
				accepted: 1,
				rejected: 0,
				discarded: 0,
				outboxed: 1,
			})
			expect(mocks.capture).toHaveBeenCalledOnce()
			expect(mocks.capture.mock.calls[0]![0]).toEqual([
				expect.objectContaining({
					endpoint: 'events',
					idempotencyKey: 'owner:answer',
					body: answer,
					source: 'live',
					needsFanOut: false,
				}),
			])
		},
	)

	it('keeps the old failure when the outbox table is not there yet', async () => {
		mocks.capture.mockResolvedValue({ status: 'unavailable' })
		mocks.deliverOrThrow.mockRejectedValue(drovrFailure(503))
		await expect(
			registered.handler({
				event: {
					data: {
						source: 'live-contact',
						events: [event('org-aihero', 'owner:answer')],
					},
				},
				step: createStep(),
				...LAST,
			}),
		).rejects.toThrow('drovr answered 503')
	})

	it.each([500, 503])(
		'outboxes a whole bulk chunk on the last attempt of a %i',
		async (httpStatus) => {
			const chunk = [
				event(
					'org-aihero',
					'kit:birth:1',
					'contact-directory',
					'contact.created',
				),
				event(
					'org-aihero',
					'kit:birth:2',
					'contact-directory',
					'contact.created',
				),
			]
			mocks.deliverBatchOrThrow.mockRejectedValue(drovrFailure(httpStatus))
			const receipt = await runCappedTree(registeredBulk, {
				events: [{ data: { source: 'kit-directory-ingest', events: chunk } }],
				step: createStep(),
				...LAST,
			})
			expect(receipt).toMatchObject({ accepted: 0, outboxed: 2 })
			const captured = mocks.capture.mock.calls.flatMap(([entries]) => entries) as DrovrOutboxEntry[]
			// Preownership plus final refusal retention, never four durable rows.
			expect(captured).toHaveLength(4)
			expect([...new Set(captured.map(entry => JSON.stringify([entry.idempotencyKey, entry.source])))].map(value => JSON.parse(value))).toEqual([
				['kit:birth:1', 'bulkIngest'],
				['kit:birth:2', 'bulkIngest'],
			])
			expect(mocks.retained.size).toBe(2)
			for (const stored of mocks.retained.values()) expect(stored.status).toBe('pending')
		},
	)

	it('outboxes the unfanned batch when the owner read runs out of retries', async () => {
		mocks.resolveOwnedContactIds.mockRejectedValue(
			new Error('Vitess: connection reset'),
		)
		const stop = event(
			'org-aihero-shadow',
			'stop:contact-1',
			'value-path-skills-course',
			'contact.unsubscribed',
		)
		const kept = event('org-aihero', 'owner:answer')
		const receipt = await registered.handler({
			event: { data: { source: 'contact-event', events: [stop, kept] } },
			step: createStep(),
			...LAST,
		})
		expect(receipt).toMatchObject({ outboxed: 2 })
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
		// MUST 1 (#339 round 2): the shadow-addressed stop is KEPT. It is the
		// fan-out candidate, the only road to the owned contact's owner copy;
		// the replay fans it out and then drops the shadow original.
		expect(mocks.capture.mock.calls[0]![0]).toEqual([
			expect.objectContaining({
				tenantId: 'org-aihero-shadow',
				idempotencyKey: 'stop:contact-1',
				needsFanOut: true,
			}),
			expect.objectContaining({
				idempotencyKey: 'owner:answer',
				needsFanOut: true,
			}),
		])
	})

	it('backstops a dead live run from onFailure with its unfanned events, shadow candidates included', async () => {
		const answer = event('org-aihero', 'owner:answer')
		const stop = event(
			'org-aihero-shadow',
			'stop:contact-1',
			'value-path-skills-course',
			'contact.unsubscribed',
		)
		await registered.config.onFailure!({
			event: {
				data: {
					event: { data: { source: 'live-contact', events: [stop, answer] } },
				},
			},
			error: new Error('boom'),
		})
		expect(mocks.capture.mock.calls[0]![0]).toEqual([
			expect.objectContaining({
				idempotencyKey: 'stop:contact-1',
				source: 'live',
				needsFanOut: true,
			}),
			expect.objectContaining({
				idempotencyKey: 'owner:answer',
				source: 'live',
				needsFanOut: true,
			}),
		])
	})

	it('still leaves synthetic principals out of an owner-read capture', async () => {
		mocks.resolveOwnedContactIds.mockRejectedValue(new Error('down'))
		const synthetic = {
			...event('org-aihero-shadow', 'stop:synthetic'),
			contactId: 'synthetic_test',
		}
		await registered.handler({
			event: { data: { source: 'contact-event', events: [synthetic] } },
			step: createStep(),
			...LAST,
		})
		const captured = (mocks.capture.mock.calls[0]?.[0] ?? []) as unknown[]
		expect(captured).toEqual([])
	})

	it('retains a misrouted capped source with its protected provenance from live onFailure', async () => {
		await outboxFailedRun(
			{
				source: 'kit-directory-ingest',
				events: [event('org-aihero', 'kit:birth:1')],
			} as never,
			new Error('boom'),
			mocks.capture,
		)
		expect(mocks.capture).toHaveBeenCalledWith([expect.objectContaining({ source: 'bulkIngest', needsFanOut: true, body: event('org-aihero', 'kit:birth:1') })], expect.any(Error))
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
	})

	it('logs, and does not throw, when the onFailure capture fails', async () => {
		mocks.capture.mockRejectedValue(new Error('db down'))
		await expect(
			outboxFailedRun(
				{
					source: 'live-contact',
					events: [event('org-aihero', 'owner:answer')],
				} as never,
				new Error('boom'),
				mocks.capture,
			),
		).resolves.toBeUndefined()
		expect(mocks.log.error).toHaveBeenCalledWith(
			'drovr.outbox.on_failure_capture_failed',
			expect.objectContaining({ idempotencyKeys: ['owner:answer'] }),
		)
	})
})

describe('row 204b: a fact never reaches drovr ahead of a stop the outbox still owes', () => {
	const at = (minute: number) =>
		`2026-09-21T12:${String(minute).padStart(2, '0')}:00.000Z`
	const fact = (key: string, minute: number, contactId = 'contact-1') => ({
		...event('org-aihero', key),
		contactId,
		occurredAt: at(minute),
	})
	const stopEvent = (key: string, type: string, minute: number) => ({
		...event('org-aihero', key, 'crash-course-evergreen-offer', type),
		occurredAt: at(minute),
	})
	const owedPurchase = {
		contactId: 'contact-1',
		eventType: 'purchase.recorded',
		occurredAt: at(10),
		status: 'pending',
	}
	const run = (
		events: unknown[],
		attempt: { attempt: number; maxAttempts: number } = {
			attempt: 0,
			maxAttempts: 9,
		},
	) =>
		registered.handler({
			event: { data: { source: 'live-contact', events } },
			step: createStep(),
			...attempt,
		})

	beforeEach(() => {
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
		mocks.deliverOrThrow.mockResolvedValue({ status: 'accepted' })
	})

	it('a pending stop → the later fact goes to the outbox behind it, not to drovr; others still post', async () => {
		mocks.openStops.mockResolvedValue([owedPurchase])
		const later = fact('owner:later', 20)
		const earlier = fact('owner:earlier', 5)
		const otherContact = fact('owner:other', 20, 'contact-2')
		const receipt = await run([earlier, later, otherContact])
		expect(mocks.openStops).toHaveBeenCalledWith(['contact-1', 'contact-2'])
		expect(receipt).toEqual({
			status: 'delivered',
			accepted: 2,
			rejected: 0,
			discarded: 0,
			outboxed: 1,
			heldBehindStop: 1,
		})
		const posted = mocks.deliverOrThrow.mock.calls.map(
			([args]) =>
				(args as { event: { idempotencyKey: string } }).event.idempotencyKey,
		)
		expect(posted).toEqual(['owner:earlier', 'owner:other'])
		expect(mocks.capture.mock.calls[0]![0]).toEqual([
			expect.objectContaining({
				idempotencyKey: 'owner:later',
				source: 'live',
				needsFanOut: false,
			}),
		])
		expect(mocks.log.info).toHaveBeenCalledWith(
			'drovr.outbox.held_behind_stop',
			expect.objectContaining({ count: 1, idempotencyKeys: ['owner:later'] }),
		)
	})

	it('holds nothing behind a refused stop any less: a rejected stop fails closed', async () => {
		mocks.openStops.mockResolvedValue([{ ...owedPurchase, status: 'rejected' }])
		await run([fact('owner:later', 20)])
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
	})

	it('never holds a stop behind a stop', async () => {
		mocks.openStops.mockResolvedValue([owedPurchase])
		await run([stopEvent('owner:unsubscribe', 'contact.unsubscribed', 20)])
		expect(mocks.deliverOrThrow).toHaveBeenCalledOnce()
		expect(mocks.capture).not.toHaveBeenCalled()
	})

	it('retries a failed stop read and posts nothing meanwhile', async () => {
		mocks.openStops.mockRejectedValue(new Error('Vitess: connection reset'))
		const error = await run([fact('owner:later', 20)]).catch(
			(thrown: unknown) => thrown,
		)
		expect(error).toMatchObject({ name: 'RetryAfterError' })
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
		expect(mocks.capture).not.toHaveBeenCalled()
	})

	it('outboxes the whole batch when the stop read fails on the last attempt: never posted unchecked', async () => {
		mocks.openStops.mockRejectedValue(new Error('Vitess: connection reset'))
		const receipt = await run(
			[fact('owner:a', 20), fact('owner:b', 21, 'contact-2')],
			LAST,
		)
		expect(receipt).toMatchObject({ accepted: 0, outboxed: 2 })
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
		expect(
			(mocks.capture.mock.calls[0]![0] as { idempotencyKey: string }[]).map(
				(entry) => entry.idempotencyKey,
			),
		).toEqual(['owner:a', 'owner:b'])
	})

	it('fails the step, never posts, when the held fact cannot be outboxed', async () => {
		mocks.openStops.mockResolvedValue([owedPurchase])
		mocks.capture.mockResolvedValue({ status: 'unavailable' })
		const error = await run([fact('owner:later', 20)]).catch(
			(thrown: unknown) => thrown,
		)
		expect(error).toMatchObject({ name: 'RetryAfterError' })
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
	})

	it('holds a later fact behind a stop this same run outboxed', async () => {
		mocks.deliverOrThrow.mockImplementation(
			async ({ event: sent }: { event: { idempotencyKey: string } }) => {
				if (sent.idempotencyKey === 'owner:purchase') throw drovrFailure(503)
				return { status: 'accepted' }
			},
		)
		const receipt = await run(
			[
				stopEvent('owner:purchase', 'purchase.recorded', 10),
				fact('owner:later', 20),
			],
			LAST,
		)
		expect(receipt).toMatchObject({
			accepted: 0,
			outboxed: 2,
			heldBehindStop: 1,
		})
		const posted = mocks.deliverOrThrow.mock.calls.map(
			([args]) =>
				(args as { event: { idempotencyKey: string } }).event.idempotencyKey,
		)
		expect(posted).toEqual(['owner:purchase'])
		expect(
			mocks.capture.mock.calls.map((call) =>
				(call[0] as { idempotencyKey: string }[]).map((e) => e.idempotencyKey),
			),
		).toEqual([['owner:purchase'], ['owner:later']])
	})

	it('holds a later fact behind a stop this same run held for a human (Opus S2, Sonnet M11)', async () => {
		mocks.deliverOrThrow.mockImplementation(
			async ({ event: sent }: { event: { idempotencyKey: string } }) =>
				sent.idempotencyKey === 'owner:purchase'
					? { status: 'rejected', httpStatus: 422, problem: { type: 'x' } }
					: { status: 'accepted' },
		)
		const receipt = await run([
			stopEvent('owner:purchase', 'purchase.recorded', 10),
			fact('owner:later', 20),
			fact('owner:other', 20, 'contact-2'),
		])
		expect(receipt).toMatchObject({
			accepted: 1,
			heldStops: 1,
			heldBehindStop: 1,
		})
		const posted = mocks.deliverOrThrow.mock.calls.map(
			([args]) =>
				(args as { event: { idempotencyKey: string } }).event.idempotencyKey,
		)
		expect(posted).toEqual(['owner:purchase', 'owner:other'])
	})

	it('never holds a fact drovr refused on the single path: it is rejected (Sonnet M02)', async () => {
		mocks.deliverOrThrow.mockResolvedValue({
			status: 'rejected',
			httpStatus: 404,
			problem: { type: 'x' },
		})
		const receipt = await run([fact('owner:later', 20)])
		expect(mocks.hold).not.toHaveBeenCalled()
		expect(receipt).toMatchObject({ rejected: 1 })
		expect(receipt).not.toHaveProperty('heldStops')
	})

	it('gates the bulk lane too', async () => {
		mocks.openStops.mockResolvedValue([owedPurchase])
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: unknown[] }) => ({
				accepted: events.length,
				rejected: 0,
			}),
		)
		const receipt = await runCappedTree(registeredBulk, {
			events: [
				{
					data: {
						source: 'kit-directory-ingest',
						events: [
							fact('owner:later', 20),
							fact('owner:other', 20, 'contact-2'),
						],
					},
				},
			],
			step: createStep(),
			attempt: 0,
			maxAttempts: 9,
		})
		expect(receipt).toMatchObject({
			accepted: 1,
			outboxed: 1,
			heldBehindStop: 1,
		})
		const sent = mocks.deliverBatchOrThrow.mock.calls.flatMap(([args]) =>
			(args as { events: { idempotencyKey: string }[] }).events.map(
				(e) => e.idempotencyKey,
			),
		)
		expect(sent).toEqual(['owner:other'])
	})

	it('delivers a batch in time order: a later fact listed before its failing stop is held, not posted (Sonnet S2, Macroscope 334)', async () => {
		mocks.deliverOrThrow.mockImplementation(
			async ({ event: e }: { event: { idempotencyKey: string } }) => {
				if (e.idempotencyKey === 'owner:purchase') throw drovrFailure(503)
				return { status: 'accepted' }
			},
		)
		const receipt = await run(
			[
				fact('owner:later', 20),
				stopEvent('owner:purchase', 'purchase.recorded', 10),
			],
			LAST,
		)
		const posted = mocks.deliverOrThrow.mock.calls.map(
			([args]) =>
				(args as { event: { idempotencyKey: string } }).event.idempotencyKey,
		)
		expect(posted).toEqual(['owner:purchase'])
		expect(receipt).toMatchObject({
			accepted: 0,
			outboxed: 2,
			heldBehindStop: 1,
		})
	})

	it('posts a stop before a fact that shares its instant, and a birth before both', async () => {
		const birth = {
			...event(
				'org-aihero',
				'owner:birth',
				'crash-course-evergreen-offer',
				'contact.created',
			),
			occurredAt: at(10),
		}
		await run([
			fact('owner:tied', 10),
			stopEvent('owner:purchase', 'purchase.recorded', 10),
			birth,
		])
		expect(
			mocks.deliverOrThrow.mock.calls.map(
				([args]) =>
					(args as { event: { idempotencyKey: string } }).event.idempotencyKey,
			),
		).toEqual(['owner:birth', 'owner:purchase', 'owner:tied'])
	})

	it.each([
		['a garbled fact goes after the stop', 'fact'],
		['a garbled stop goes before the fact', 'stop'],
	] as const)(
		'fails closed on an instant that does not parse in the batch order: %s',
		async (_case, garbled) => {
			mocks.deliverOrThrow.mockImplementation(
				async ({ event: e }: { event: { idempotencyKey: string } }) => {
					if (e.idempotencyKey === 'owner:purchase') throw drovrFailure(503)
					return { status: 'accepted' }
				},
			)
			const theFact = fact('owner:answer', 20)
			const theStop = stopEvent('owner:purchase', 'purchase.recorded', 10)
			await run(
				garbled === 'fact'
					? [{ ...theFact, occurredAt: 'not-a-date' }, theStop]
					: [theFact, { ...theStop, occurredAt: 'not-a-date' }],
				LAST,
			)
			expect(
				mocks.deliverOrThrow.mock.calls.map(
					([args]) =>
						(args as { event: { idempotencyKey: string } }).event
							.idempotencyKey,
				),
			).toEqual(['owner:purchase'])
		},
	)

	it('holds a fact whose instant does not parse behind an owed stop (fails closed)', async () => {
		mocks.openStops.mockResolvedValue([owedPurchase])
		await run([{ ...fact('owner:garbled', 20), occurredAt: 'not-a-date' }])
		expect(mocks.deliverOrThrow).not.toHaveBeenCalled()
	})

	it("captures a live stop on its first failure, due when Inngest's retries run out; an unrelated fact is not captured early", async () => {
		mocks.deliverOrThrow.mockRejectedValue(drovrFailure(503))
		await expect(
			run([stopEvent('owner:purchase', 'purchase.recorded', 10)]),
		).rejects.toMatchObject({ name: 'RetryAfterError' })
		expect(mocks.capture).toHaveBeenCalledOnce()
		const [entries, , options] = mocks.capture.mock.calls[0]! as [
			{ idempotencyKey: string }[],
			unknown,
			{ nextAttemptAt: Date },
		]
		expect(entries.map((e) => e.idempotencyKey)).toEqual(['owner:purchase'])
		const window = options.nextAttemptAt.getTime() - Date.now()
		expect(window).toBeGreaterThan(78 * 60_000)
		expect(window).toBeLessThanOrEqual(78.75 * 60_000)

		mocks.capture.mockClear()
		await expect(run([fact('owner:answer', 10, 'contact-2')])).rejects.toMatchObject({
			name: 'RetryAfterError',
		})
		expect(mocks.capture).not.toHaveBeenCalled()
	})

	it('settles a live stop when a later retry delivers it', async () => {
		await run([stopEvent('owner:purchase', 'purchase.recorded', 10)], {
			attempt: 3,
			maxAttempts: 9,
		})
		expect(mocks.settle).toHaveBeenCalledWith(
			[expect.objectContaining({ idempotencyKey: 'owner:purchase' })],
			'delivered by an Inngest retry',
		)
		mocks.settle.mockClear()
		await run([fact('owner:answer', 10)], { attempt: 3, maxAttempts: 9 })
		expect(mocks.settle).not.toHaveBeenCalled()
	})

	it('holds a stop drovr refused on a retry, and never settles it: the gate stays closed (row 204c)', async () => {
		mocks.deliverOrThrow.mockResolvedValue({
			status: 'rejected',
			httpStatus: 404,
			problem: { type: 'urn:drovr:problem:unknown-route' },
		})
		const receipt = await run(
			[stopEvent('owner:purchase', 'purchase.recorded', 10)],
			{ attempt: 3, maxAttempts: 9 },
		)
		expect(mocks.hold).toHaveBeenCalledWith(
			[expect.objectContaining({ idempotencyKey: 'owner:purchase' })],
			expect.stringContaining('unknown-route'),
			404,
		)
		expect(mocks.settle).not.toHaveBeenCalled()
		expect(receipt).toMatchObject({ heldStops: 1, rejected: 0 })
	})

	it('retains a coded never-born owner rejection without fake delivery or lifting directory debt', async () => {
		mocks.deliverOrThrow.mockResolvedValue({ status: 'rejected', httpStatus: 409, problem: { type: 'urn:drovr:problem:contact-never-born' } })
		mocks.isNeverBornOwnerStop.mockReturnValue(true)
		const directory = { ...stopEvent('directory:unsubscribe', 'contact.unsubscribed', 5), journeyId: 'contact-directory' as const, type: 'contact.unsubscribed' as const, payload: undefined }
		await mocks.capture([outboxEntryForEvent(directory, 'live')])
		const receipt = await run([stopEvent('owner:unsubscribe', 'contact.unsubscribed', 10)], { attempt: 3, maxAttempts: 9 })
		expect(receipt).toMatchObject({ accepted: 0, rejected: 1, ownerStopsNeverBorn: 1 })
		expect(mocks.hold).not.toHaveBeenCalled()
		expect(mocks.settle).not.toHaveBeenCalled()
		expect(mocks.recordOwnerStopRejection).toHaveBeenCalledOnce()
		expect([...mocks.retained.values()].find(item => item.event.idempotencyKey === 'owner:unsubscribe')?.status).toBe('rejected')
		expect(await mocks.openStops(['contact-1'])).toEqual([expect.objectContaining({ journeyId: 'contact-directory', status: 'pending' })])
	})

	it('keeps a stop that 409s event-not-live on a retry owed, then settles it when a later retry folds it (the hawk)', async () => {
		const notLive = Object.assign(
			new Error('drovr does not take this event type yet (409 event-not-live)'),
			{ name: 'DrovrDeliveryFailedError', httpStatus: 409 },
		)
		const purchase = [stopEvent('owner:purchase', 'purchase.recorded', 10)]
		mocks.deliverOrThrow.mockRejectedValueOnce(notLive)
		await expect(run(purchase, { attempt: 2, maxAttempts: 9 })).rejects.toThrow(
			'event-not-live',
		)
		expect(mocks.settle).not.toHaveBeenCalled()
		expect(mocks.hold).not.toHaveBeenCalled()
		expect(mocks.capture).toHaveBeenCalledWith(
			[expect.objectContaining({ idempotencyKey: 'owner:purchase' })],
			notLive,
			expect.objectContaining({ nextAttemptAt: expect.any(Date) }),
		)
		mocks.deliverOrThrow.mockResolvedValue({ status: 'accepted' })
		await run(purchase, { attempt: 3, maxAttempts: 9 })
		expect(mocks.settle).toHaveBeenCalledWith(
			[expect.objectContaining({ idempotencyKey: 'owner:purchase' })],
			'delivered by an Inngest retry',
		)
	})

	it('isolates stop acceptance from a sibling fact refusal and holds an actual refused stop without rewriting delivered history', async () => {
		const bulk = (attempt: number, batch = [stopEvent('owner:unsubscribe', 'contact.unsubscribed', 10)]) =>
			runCappedTree(registeredBulk, {
				events: [
					{
						data: {
							source: 'kit-directory-ingest',
							events: batch,
						},
					},
				],
				step: createStep(),
				attempt,
				maxAttempts: 9,
			})
		mocks.deliverBatchOrThrow.mockResolvedValue({ accepted: 1, rejected: 0 })
		await bulk(2)
		expect(mocks.settle).toHaveBeenLastCalledWith(
			[expect.objectContaining({ idempotencyKey: 'owner:unsubscribe' })],
			'delivered by an Inngest retry',
		)
		// Different immutable keys model a genuinely new logical send. A
		// delivered key must not be reopened to manufacture another answer.
		const siblingStop = stopEvent('owner:unsubscribe-sibling', 'contact.unsubscribed', 10)
		const rejectedFact = fact('owner:refused-fact', 20)
		mocks.deliverBatchOrThrow.mockImplementation(async ({ events }) => events[0].idempotencyKey === siblingStop.idempotencyKey ? { accepted: 1, rejected: 0 } : { accepted: 0, rejected: 1, refused: [{ event: events[0], httpStatus: 400, problem: { type: 'urn:drovr:problem:malformed-event' } }] })
		await bulk(2, [siblingStop, rejectedFact])
		expect(mocks.settle).toHaveBeenLastCalledWith(
			[expect.objectContaining({ idempotencyKey: siblingStop.idempotencyKey })],
			'delivered by an Inngest retry',
		)
		// A refused stop is held, never settled (row 204c).
		mocks.settle.mockClear()
		const unsubscribe = stopEvent(
			'owner:unsubscribe-denied',
			'contact.unsubscribed',
			10,
		)
		mocks.deliverBatchOrThrow.mockResolvedValue({
			accepted: 0,
			rejected: 1,
			refused: [
				{
					event: unsubscribe,
					httpStatus: 403,
					problem: { type: 'urn:drovr:problem:tenant-mismatch' },
				},
			],
		})
		const receipt = await bulk(2, [unsubscribe])
		expect(mocks.hold).toHaveBeenCalledWith(
			[expect.objectContaining({ idempotencyKey: unsubscribe.idempotencyKey })],
			expect.stringContaining('tenant-mismatch'),
			403,
		)
		expect(mocks.settle).not.toHaveBeenCalled()
		expect(receipt).toMatchObject({ rejected: 0, heldStops: 1 })
	})

	it('owns stops before shards, yields a gated fact without booking, and resumes its unchanged debt after the stop lands', async () => {
		mocks.deliverBatchOrThrow.mockRejectedValueOnce(drovrFailure(503))
		const original = fact('owner:answer', 20)
		const receipt = await runCappedTree(registeredBulk, { events: [{ data: { source: 'kit-directory-ingest', events: [original, stopEvent('owner:unsubscribe', 'contact.unsubscribed', 10)] } }], step: createStep(), attempt: 0, maxAttempts: 9 })
		expect(receipt).toMatchObject({ accepted: 1, heldBehindStop: 1, outboxed: 1 })
		expect(mocks.pace).toHaveBeenCalledTimes(2)
		expect(mocks.deliverBatchOrThrow.mock.calls.flatMap(([args]) => args.events).map(item => item.idempotencyKey)).toEqual(['owner:unsubscribe', 'owner:unsubscribe'])
		expect(mocks.hold).not.toHaveBeenCalled()
		expect((mocks.capture.mock.calls[0]![0] as DrovrOutboxEntry[]).map(item => item.idempotencyKey)).toEqual(['owner:unsubscribe'])
		const owed = [...mocks.retained.values()].find(item => item.event.idempotencyKey === original.idempotencyKey)!
		expect(owed.status).toBe('pending')
		expect(owed.event).toEqual(original)
		const firstClock = owed.clampAt
		const resumed = await runCappedTree(registeredIngest, { runId: 'synthetic-replay', events: [{ data: { source: 'kit-directory-ingest', events: [owed.event], firstFailedAt: new Date(firstClock).toISOString() } }], step: createStep(), attempt: 0, maxAttempts: 9 })
		expect(resumed).toMatchObject({ accepted: 1 })
		expect(mocks.pace).toHaveBeenCalledTimes(3)
		expect(owed).toMatchObject({ event: original, clampAt: firstClock, status: 'delivered' })
		expect(mocks.deliverBatchOrThrow.mock.calls.at(-1)![0]).toMatchObject({ events: [original], clampAt: firstClock })
	})

	it('holds a later fact listed in an earlier bulk chunk behind a stop listed last (time order across chunks)', async () => {
		const fillers = Array.from({ length: 3 }, (_, i) =>
			fact(`owner:filler-${i}`, 15, `contact-f${i}`),
		)
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: { idempotencyKey: string }[] }) => {
				if (events.some((e) => e.idempotencyKey === 'owner:purchase'))
					throw drovrFailure(503)
				return { accepted: events.length, rejected: 0 }
			},
		)
		const step = createStep()
		const receipt = await runCappedTree(registeredBulk, {
			events: [
				{
					data: {
						source: 'kit-directory-ingest',
						events: [
							fact('owner:later', 20),
							...fillers,
							stopEvent('owner:purchase', 'purchase.recorded', 10),
						],
					},
				},
			],
			step,
			...LAST,
		})
		const sent = mocks.deliverBatchOrThrow.mock.calls.flatMap(([args]) =>
			(args as { events: { idempotencyKey: string }[] }).events.map(
				(e) => e.idempotencyKey,
			),
		)
		expect(sent).not.toContain('owner:later')
		expect(receipt).toMatchObject({ heldBehindStop: 1 })
		// The chunk layout changed with the order: new step ids, so a run in
		// flight across the deploy re-posts (drovr dedupes) instead of
		// replaying a memoized chunk that now holds other events.
		expect(
			(step.run as ReturnType<typeof vi.fn>).mock.calls.map(([id]) => id),
		).toEqual(expect.arrayContaining([expect.stringMatching(/physical-\d+:paced-single:org-aihero:[a-f0-9]{64}:attempt:8:booking:0$/)]))
	})

	it("posts a birth ahead of its own contact's earlier stop, as the replay does: [birth 12:20, purchase 12:10] → birth first, nothing refused (Sonnet S6, round 3)", async () => {
		const born = new Set<string>()
		mocks.deliverOrThrow.mockImplementation(
			async ({
				event: e,
			}: {
				event: { type: string; contactId: string; journeyId: string }
			}) => {
				const key = `${e.contactId}|${e.journeyId}`
				if (e.type === 'contact.created') born.add(key)
				else if (!born.has(key)) return { status: 'rejected' }
				return { status: 'accepted' }
			},
		)
		const birth = {
			...event(
				'org-aihero',
				'owner:birth',
				'crash-course-evergreen-offer',
				'contact.created',
			),
			occurredAt: at(20),
		}
		const receipt = await run([
			birth,
			stopEvent('owner:purchase', 'purchase.recorded', 10),
		])
		expect(
			mocks.deliverOrThrow.mock.calls.map(
				([args]) =>
					(args as { event: { idempotencyKey: string } }).event.idempotencyKey,
			),
		).toEqual(['owner:birth', 'owner:purchase'])
		expect(receipt).toMatchObject({ accepted: 2, rejected: 0 })
	})

	it('moves a birth up only for its own contact and journey', async () => {
		const birth = {
			...event(
				'org-aihero',
				'owner:birth',
				'crash-course-evergreen-offer',
				'contact.created',
			),
			occurredAt: at(20),
		}
		await run([
			birth,
			{
				...fact('owner:other-contact', 10, 'contact-2'),
				journeyId: 'crash-course-evergreen-offer',
			},
			{
				...fact('owner:other-journey', 15),
				journeyId: 'value-path-skills-course',
			},
		])
		expect(
			mocks.deliverOrThrow.mock.calls.map(
				([args]) =>
					(args as { event: { idempotencyKey: string } }).event.idempotencyKey,
			),
		).toEqual(['owner:other-contact', 'owner:other-journey', 'owner:birth'])
	})

	it('holds a later fact in a later chunk behind a stop an earlier chunk outboxed', async () => {
		const fillers = Array.from({ length: 3 }, (_, i) =>
			fact(`owner:filler-${i}`, 15, `contact-f${i}`),
		)
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: { idempotencyKey: string }[] }) => {
				if (events.some((e) => e.idempotencyKey === 'owner:purchase'))
					throw drovrFailure(503)
				return { accepted: events.length, rejected: 0 }
			},
		)
		const receipt = await runCappedTree(registeredBulk, {
			events: [
				{
					data: {
						source: 'kit-directory-ingest',
						events: [
							stopEvent('owner:purchase', 'purchase.recorded', 10),
							...fillers,
							fact('owner:later', 20),
						],
					},
				},
			],
			step: createStep(),
			...LAST,
		})
		// Nine real failed stop attempts; three independent contacts still land.
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledTimes(12)
		expect(receipt).toMatchObject({
			accepted: 3,
			outboxed: 2,
			heldBehindStop: 1,
		})
		expect(
			(mocks.capture.mock.calls.at(-1)![0] as { idempotencyKey: string }[]).map(
				(e) => e.idempotencyKey,
			),
		).toEqual(['owner:later'])
	})
})

describe('row 204c: a backfill stop that is owed gates the run, whatever the source', () => {
	const at = (minute: number) =>
		`2026-09-21T12:${String(minute).padStart(2, '0')}:00.000Z`
	const unsubscribe = {
		...event(
			'org-aihero',
			'backfill:unsubscribe',
			'contact-directory',
			'contact.unsubscribed',
		),
		occurredAt: at(5),
	}
	const laterFact = {
		...event('org-aihero', 'live:later-fact'),
		occurredAt: at(20),
	}
	const bulkRun = (attempt = 0) =>
		runCappedTree(registeredBulk, {
			events: [
				{ data: { source: 'kit-directory-ingest', events: [laterFact] } },
				{ data: { source: 'contact-sync-backfill', events: [unsubscribe] } },
			],
			step: { ...createStep(), sendEvent: vi.fn(async () => undefined) },
			attempt,
			maxAttempts: 9,
		})

	beforeEach(() => {
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('outboxes a backfill stop drovr answered event-not-live (the straggler owns it for a day), and holds a later fact of that contact from another source behind it', async () => {
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: { idempotencyKey: string }[] }) =>
				events.some((e) => e.idempotencyKey === 'backfill:unsubscribe')
					? {
							accepted: 0,
							rejected: 0,
							deferred: [{ event: unsubscribe, reason: 'event-not-live' }],
						}
					: { accepted: events.length, rejected: 0 },
		)
		const before = Date.now()
		const receipt = await bulkRun()
		const gated = mocks.capture.mock.calls.find(
			([, , options]) => (options as { status?: string } | undefined)?.status === 'deferred',
		)
		expect(gated?.[0]).toEqual([
			expect.objectContaining({
				idempotencyKey: 'backfill:unsubscribe',
				source: 'bulkBackfill',
			}),
		])
		const wait = (gated?.[2] as { nextAttemptAt: Date }).nextAttemptAt.getTime()
		expect(wait - before).toBeGreaterThanOrEqual(24 * 60 * 60_000 - 1000)
		// The backfill went first, and its gate held the other source's fact.
		const posted = mocks.deliverBatchOrThrow.mock.calls.flatMap(([args]) =>
			(args as { events: { idempotencyKey: string }[] }).events.map(
				(e) => e.idempotencyKey,
			),
		)
		expect(posted).toEqual(['backfill:unsubscribe'])
		expect(receipt).toMatchObject({
			deferred: 1,
			deferredStopsGated: 1,
			heldBehindStop: 1,
		})
	})

	it.each(['contact.unsubscribed', 'purchase.recorded'])(
		'counts a bulk owner copy of a %s drovr says was never born there as rejected, and never holds it (the prod shape: a purchase)',
		async (type) => {
			const ownerCopy = {
				...unsubscribe,
				idempotencyKey: `owner:aihero:crash-course-evergreen-offer:${type}:x`,
				journeyId: 'crash-course-evergreen-offer',
				type,
			}
			mocks.deliverBatchOrThrow.mockImplementation(
				async ({ events }: { events: { idempotencyKey: string }[] }) =>
					events.some((e) => e.idempotencyKey === ownerCopy.idempotencyKey)
						? {
								accepted: 0,
								rejected: 1,
								refused: [
									{
										event: ownerCopy,
										httpStatus: 409,
										problem: { type: 'urn:drovr:problem:contact-never-born' },
									},
								],
							}
						: { accepted: events.length, rejected: 0 },
			)
			const receipt = await runCappedTree(registeredBulk, { events: [{ data: { source: 'contact-sync-backfill', events: [ownerCopy] } }, { data: { source: 'kit-directory-ingest', events: [laterFact] } }], step: createStep(), attempt: 0, maxAttempts: 9 })
			expect(mocks.hold).not.toHaveBeenCalled()
			expect(receipt).toMatchObject({ rejected: 1, accepted: 1 })
			expect(receipt).not.toHaveProperty('heldStops')
		},
	)

	it('holds only the stops of a chunk drovr refused, never a fact, and each group of refusals under its own cause', async () => {
		const otherStop = {
			...event(
				'org-aihero',
				'backfill:bounce',
				'contact-directory',
				'contact.bounced',
			),
			contactId: 'contact-2',
			occurredAt: at(6),
		}
		const fact = {
			...event('org-aihero', 'backfill:fact'),
			contactId: 'contact-3',
			occurredAt: at(7),
		}
		const thirdStop = {
			...event(
				'org-aihero',
				'backfill:complaint',
				'contact-directory',
				'contact.complained',
			),
			contactId: 'contact-4',
			occurredAt: at(8),
		}
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: { idempotencyKey: string }[] }) =>
				events.some((e) => e.idempotencyKey === 'backfill:unsubscribe')
					? {
							accepted: 0,
							rejected: 4,
							refused: [
								{ event: unsubscribe, httpStatus: 404, problem: { type: 'a' } },
								{ event: otherStop, httpStatus: 404, problem: { type: 'b' } },
								{ event: fact, httpStatus: 404, problem: { type: 'b' } },
								{ event: thirdStop, httpStatus: 404, problem: { type: 'b' } },
							],
						}
					: { accepted: events.length, rejected: 0 },
		)
		const receipt = await runCappedTree(registeredBulk, {
			events: [
				{
					data: {
						source: 'contact-sync-backfill',
						events: [unsubscribe, otherStop, fact, thirdStop],
					},
				},
			],
			step: { ...createStep(), sendEvent: vi.fn(async () => undefined) },
			attempt: 0,
			maxAttempts: 9,
		})
		expect(mocks.hold).toHaveBeenCalledTimes(2)
		const held = mocks.hold.mock.calls.map(([entries, reason]) => [
			(entries as { idempotencyKey: string }[]).map((e) => e.idempotencyKey),
			reason,
		])
		expect(held).toEqual([
			[['backfill:unsubscribe'], expect.stringContaining('(404)')],
			// The same status, a different problem: its own group (Opus V8).
			// Two stops under one answer: one hold, counted twice (Sonnet 2).
			[
				['backfill:bounce', 'backfill:complaint'],
				expect.stringContaining('"type":"b"'),
			],
		])
		expect(receipt).toMatchObject({ heldStops: 3, rejected: 1 })
	})

	it('holds a backfill stop drovr refused with a 4xx, and a later fact of that contact from another source waits behind it', async () => {
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: { idempotencyKey: string }[] }) =>
				events.some((e) => e.idempotencyKey === 'backfill:unsubscribe')
					? {
							accepted: 0,
							rejected: 1,
							refused: [
								{
									event: unsubscribe,
									httpStatus: 400,
									problem: { type: 'urn:drovr:problem:malformed-event' },
								},
							],
						}
					: { accepted: events.length, rejected: 0 },
		)
		const receipt = await bulkRun()
		expect(mocks.hold).toHaveBeenCalledWith(
			[expect.objectContaining({ idempotencyKey: 'backfill:unsubscribe' })],
			expect.stringContaining('malformed-event'),
			400,
		)
		expect(receipt).toMatchObject({
			rejected: 0,
			heldStops: 1,
			heldBehindStop: 1,
		})
	})

	it('never settles a stop its retry answered event-not-live: it stays owed (the early settle skips it)', async () => {
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: { idempotencyKey: string }[] }) =>
				events.some((e) => e.idempotencyKey === 'backfill:unsubscribe')
					? {
							accepted: 0,
							rejected: 0,
							deferred: [{ event: unsubscribe, reason: 'event-not-live' }],
						}
					: { accepted: events.length, rejected: 0 },
		)
		await bulkRun(2)
		for (const [entries] of mocks.settle.mock.calls)
			expect(
				(entries as { idempotencyKey: string }[]).map((e) => e.idempotencyKey),
			).not.toContain('backfill:unsubscribe')
	})

	it('leaves the other sources alone when the flag is off: the backfill is dropped, not gated', async () => {
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', '')
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: unknown[] }) => ({
				accepted: events.length,
				rejected: 0,
			}),
		)
		const receipt = await bulkRun()
		expect(receipt).toMatchObject({ accepted: 1, backfillDropped: 1 })
	})
})

/**
 * Inngest's replay: a step that returned is memoized for every later
 * attempt of the run; one that threw runs again.
 */
const memoStep = () => {
	const done = new Map<string, unknown>()
	const ran: string[] = []
	const step: Step = {
		...createStep(),
		run: vi.fn(async (id: string, operation: () => unknown) => {
			if (done.has(id)) return done.get(id)
			ran.push(id)
			const result = await operation()
			done.set(id, result)
			return result
		}),
	}
	return { step, ran }
}

describe('row 201g (#345 S1): a run clamps its births at its first send, on every attempt', () => {
	const FIRST = Date.parse('2026-09-30T12:00:00.000Z')
	const TEN_MINUTES = 10 * 60_000
	const birth = {
		...event(
			'org-aihero',
			'owner:birth:contact-1',
			'value-path-skills-course',
			'contact.created',
		),
		occurredAt: '2026-09-30T11:59:00.000Z',
	}

	beforeEach(() => {
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(FIRST)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('the live lane: a retry 10 minutes on, and the last attempt, send the first instant, and the outbox carries it', async () => {
		const { step, ran } = memoStep()
		const live = (attempt: number) =>
			registered
				.handler({
					event: { data: { source: 'live-contact', events: [birth] } },
					step,
					attempt,
					maxAttempts: 9,
				})
				.catch(() => undefined)
		mocks.deliverOrThrow.mockRejectedValue(drovrFailure(503))
		await live(0)
		vi.setSystemTime(FIRST + TEN_MINUTES)
		await live(1)
		vi.setSystemTime(FIRST + 3 * 60 * 60_000)
		await live(LAST.attempt)
		expect(
			mocks.deliverOrThrow.mock.calls.map(
				([args]) => (args as { clampAt: number }).clampAt,
			),
		).toEqual([FIRST, FIRST, FIRST])
		expect(ran.filter((id) => id === DROVR_CLAMP_INSTANT_STEP)).toHaveLength(1)
		expect(mocks.capture).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					idempotencyKey: 'owner:birth:contact-1',
					body: birth,
					occurredAt: birth.occurredAt,
					firstSentAt: new Date(FIRST).toISOString(),
				}),
			],
			expect.anything(),
		)
	})

	it('the bulk lane: a chunk retried 10 minutes on, and its last attempt, send the first instant, and the outbox carries it', async () => {
		const { step, ran } = memoStep()
		const bulk = (attempt: number) =>
			runCappedTree(registeredBulk, {
					events: [
						{ data: { source: 'evergreen-pitch-backfill', events: [birth] } },
					],
					step,
					attempt,
					maxAttempts: 9,
				})
				.catch(() => undefined)
		mocks.deliverBatchOrThrow.mockRejectedValue(drovrFailure(503))
		await bulk(0)
		vi.setSystemTime(FIRST + TEN_MINUTES)
		await bulk(1)
		vi.setSystemTime(FIRST + 3 * 60 * 60_000)
		await bulk(LAST.attempt)
		expect(
			mocks.deliverBatchOrThrow.mock.calls.map(
				([args]) => (args as { clampAt: number }).clampAt,
			),
		).toEqual(Array(9).fill(FIRST))
		expect(ran.filter((id) => id === DROVR_CLAMP_INSTANT_STEP)).toHaveLength(1)
		expect(mocks.capture).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					idempotencyKey: 'owner:birth:contact-1',
					firstSentAt: new Date(FIRST).toISOString(),
				}),
			],
			expect.anything(),
		)
	})

	it('the contact-sync backfill chunk (deferNotLive) sends the first instant too', async () => {
		// Its events are directory events today, which are never clamped; if
		// a birth ever rides it, its retry must still post the same bytes.
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
		const { step, ran } = memoStep()
		const backfill = (attempt: number) =>
			runCappedTree(registeredBulk, {
					events: [
						{ data: { source: 'contact-sync-backfill', events: [birth] } },
					],
					step,
					attempt,
					maxAttempts: 9,
				})
				.catch(() => undefined)
		mocks.deliverBatchOrThrow.mockRejectedValue(drovrFailure(503))
		await backfill(0)
		vi.setSystemTime(FIRST + TEN_MINUTES)
		await backfill(1)
		vi.unstubAllEnvs()
		const calls = mocks.deliverBatchOrThrow.mock.calls.map(
			([args]) => args as { clampAt: number; deferNotLive?: boolean },
		)
		expect(calls.map(({ deferNotLive }) => deferNotLive)).toEqual(Array(9).fill(true))
		expect(calls.map(({ clampAt }) => clampAt)).toEqual(Array(9).fill(FIRST))
		expect(
			ran.filter((id) => id.endsWith(DROVR_CLAMP_INSTANT_STEP)),
		).toHaveLength(1)
	})

	it('takes no step for a run with no sending-journey birth', async () => {
		const { step, ran } = memoStep()
		await registered.handler({
			event: {
				data: {
					source: 'live-contact',
					events: [event('org-aihero', 'owner:answer')],
				},
			},
			step,
			attempt: 0,
			maxAttempts: 9,
		})
		expect(mocks.deliverOrThrow).toHaveBeenCalledOnce()
		expect(ran).not.toContain(DROVR_CLAMP_INSTANT_STEP)
	})
})

describe('row 201g: the freeze is decided once per run, on every bulk source (Sonnet 2 S1, S2)', () => {
	const valuePathBirth = event(
		'org-aihero',
		'owner:birth:contact-1',
		'value-path-skills-course',
		'contact.created',
	)

	beforeEach(() => {
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: unknown[] }) => ({
				accepted: events.length,
				rejected: 0,
			}),
		)
	})

	it("keeps a run's first decision on its retry, so the chunks never shift, and logs it once", async () => {
		const { step } = memoStep()
		const run = () =>
			runCappedTree(registeredBulk, {
				events: [
					{
						data: { events: [valuePathBirth], source: 'kit-directory-ingest' },
					},
				],
				step,
			})
		mocks.valuePathBulkFreeze.mockReturnValue({
			frozen: false,
			signedOffBy: 'hawk 2026-10-20',
		})
		const first = await run()
		// The window opens, or the sign-off is unset, before the retry.
		mocks.valuePathBulkFreeze.mockReturnValue({
			frozen: true,
			reason: 'now frozen',
		})
		const retry = await run()
		expect(first).toMatchObject({ accepted: 1 })
		expect(retry).toMatchObject({ accepted: 1 })
		expect(retry).not.toHaveProperty('valuePathBirthsRefused')
		expect(mocks.valuePathBulkFreeze).toHaveBeenCalledOnce()
		expect(mocks.log.warn).toHaveBeenCalledOnce()
		expect(mocks.log.error).not.toHaveBeenCalled()
	})

	it('refuses a value-path birth under the contact-sync-backfill source too', async () => {
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
		mocks.valuePathBulkFreeze.mockReturnValue({ frozen: true, reason: 'x' })
		const receipt = await runCappedTree(registeredBulk, {
			events: [
				{
					data: { events: [valuePathBirth], source: 'contact-sync-backfill' },
				},
			],
			step: createStep(),
		})
		vi.unstubAllEnvs()
		const sent = mocks.deliverBatchOrThrow.mock.calls.flatMap(
			([args]) => (args as { events: unknown[] }).events,
		)
		expect(sent).toEqual([])
		expect(receipt).toMatchObject({ valuePathBirthsRefused: 1 })
	})
})

describe('delivery order: the evergreen start is a birth, so it goes before its journey (Sonnet 2 nit 3)', () => {
	const on = (
		journeyId: string,
		type: string,
		occurredAt: string,
		key: string,
	) => ({ ...event('org-aihero', key, journeyId, type), occurredAt })

	it('puts the evergreen start before an earlier evergreen fact of the contact', () => {
		const coupon = on(
			'crash-course-evergreen-offer',
			'evergreen.coupon-issued',
			'2026-09-30T10:00:00.000Z',
			'coupon',
		)
		const start = on(
			'crash-course-evergreen-offer',
			'course.sequence-exhausted',
			'2026-09-30T11:00:00.000Z',
			'start',
		)
		expect(
			inDeliveryOrder([coupon, start] as never).map((e) => e.idempotencyKey),
		).toEqual(['start', 'coupon'])
	})

	it('keeps the skills course exhaustion, a fact there, in time order', () => {
		const answer = on(
			'value-path-skills-course',
			'value-path.answer-selected',
			'2026-09-30T10:00:00.000Z',
			'answer',
		)
		const exhausted = on(
			'value-path-skills-course',
			'course.sequence-exhausted',
			'2026-09-30T11:00:00.000Z',
			'exhausted',
		)
		expect(
			inDeliveryOrder([exhausted, answer] as never).map(
				(e) => e.idempotencyKey,
			),
		).toEqual(['answer', 'exhausted'])
	})
})
