import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	batchStepId: vi.fn(
		(tenantId: string, chunkIndex: number) =>
			`batch:${tenantId}:${chunkIndex}`,
	),
	createFunction: vi.fn(
		(config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
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
}))

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
vi.mock('@/lib/subscriber-marketing/drovr-shadow-emitter', () => ({
	drovrApiKeyForTenant: mocks.drovrApiKeyForTenant,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID: 'shadow-newsletter',
	DROVR_SHADOW_TENANT_ID: 'org-aihero-shadow',
}))
vi.mock('@/lib/subscriber-marketing/drovr-ownership', () => ({
	fanOutOwnedEvents: mocks.fanOutOwnedEvents,
	isShadowNewsletterBirth: mocks.isShadowNewsletterBirth,
}))
vi.mock('@/lib/subscriber-marketing/drovr-ownership-live', () => ({
	resolveOwnedContactIds: mocks.resolveOwnedContactIds,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { contactSyncRetryRequest } from '@/lib/subscriber-marketing/contact-sync-straggler-retry'
import type { DeferredDrovrEvent } from '@/lib/subscriber-marketing/drovr-shadow-delivery'

import {
	drovrEventsDeliver,
	drovrEventsDeliverBulk,
} from './drovr-events-deliver'

type Step = {
	run: (id: string, operation: () => unknown) => Promise<unknown>
}

type Registered = {
	config: {
		id: string
		concurrency: Array<{ key?: string; limit: number }>
		batchEvents?: { maxSize: number; timeout: string }
	}
	trigger: { event: string }
	handler: (input: Record<string, unknown>) => Promise<unknown>
}

const registered = drovrEventsDeliver as unknown as Registered
const registeredBulk = drovrEventsDeliverBulk as unknown as Registered

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
})

const createStep = (): Step => ({
	run: vi.fn(async (_id, operation) => operation()),
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.resolveOwnedContactIds.mockResolvedValue([])
	mocks.isShadowNewsletterBirth.mockReturnValue(false)
	mocks.drovrApiKeyForTenant.mockImplementation((tenantId: string) =>
		tenantId === 'org-aihero' ? 'authority-key' : undefined,
	)
	mocks.deliverOrThrow.mockResolvedValue({ status: 'accepted' })
	mocks.isNeverBornOwnerStop.mockReturnValue(false)
	mocks.deliverBatchOrThrow.mockImplementation(
		({ events }: { events: unknown[] }) =>
			Promise.resolve({ accepted: events.length, rejected: 0 }),
	)
})

describe('drovr events deliver registration', () => {
	it('keeps live and bulk work on their existing isolated queues', () => {
		expect(registered.config).toMatchObject({
			id: 'drovr-events-deliver-v1',
			concurrency: [{ limit: 8 }],
		})
		expect(registered.trigger).toEqual({ event: 'drovr/events.deliver' })
		expect(registeredBulk.config).toMatchObject({
			id: 'drovr-events-deliver-bulk-v1',
			concurrency: [{ limit: 4 }],
			batchEvents: { maxSize: 100, timeout: '10s' },
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
		expect(mocks.deliverOrThrow.mock.calls.map(([args]) => args.event)).toEqual(
			authorityEvents,
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
		mocks.fanOutOwnedEvents.mockReturnValue([synthetic, real])

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

		const bulk = await registeredBulk.handler({
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

	it('counts and logs one discarded shadow group in the bulk handler', async () => {
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
		mocks.fanOutOwnedEvents.mockReturnValue([
			...shadowEvents,
			...authorityEvents,
		])

		const receipt = await registeredBulk.handler({
			events: [{ data: { events: shadowEvents } }],
			step: createStep(),
		})

		expect(receipt).toEqual({
			status: 'delivered',
			accepted: 2,
			rejected: 0,
			discarded: 2,
		})
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledOnce()
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledWith({
			events: authorityEvents,
			config: {
				ingestUrl: 'https://drovr.test/events',
				apiKey: 'authority-key',
			},
		})
		expect(mocks.log.info).toHaveBeenCalledOnce()
		expect(mocks.log.info).toHaveBeenCalledWith(
			'drovr.shadow.events_discarded',
			{
				tenantId: 'org-aihero-shadow',
				count: 2,
				deliveryLane: 'bulk',
			},
		)
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
		const receipt = await registeredBulk.handler({
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
		const receipt = await registeredBulk.handler({
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
			run: vi.fn(async (id: string, operation: () => unknown) => {
				if (memo.has(id)) return memo.get(id)
				const result = await operation()
				memo.set(id, result)
				return result
			}),
		})
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
		const backfill = Array.from({ length: 100 }, (_, index) =>
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
			registeredBulk.handler({
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
		await expect(run()).rejects.toThrow('drovr 503')
		// drovr rolls back: the flag goes off before the retry.
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', '')
		await run()
		vi.unstubAllEnvs()
		expect(posted).toContainEqual(ingest)
		// And no backfill event reached drovr after the flag went off.
		const afterOff = posted.slice(1).flat()
		expect(afterOff.some((e) => backfill.includes(e as never))).toBe(false)
	})
})

describe('backfill refusals follow the push contract (§4)', () => {
	const now = Date.parse('2026-10-01T12:00:00.000Z')
	const profileEvent = (contactId: string) =>
		event(
			'org-aihero',
			`profile:${contactId}:1`,
			'contact-directory',
			'contact.profile.updated',
		)
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
		mocks.deliverBatchOrThrow.mockResolvedValue({
			accepted: 1,
			rejected: 0,
			deferred: [
				{ event: notLive, reason: 'event-not-live' },
				{ event: cold, reason: 'cold-start-unhandled' },
			],
		})
		const sent: unknown[] = []
		const receipt = await registeredBulk.handler({
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
		// The straggler retry's own request (its id, and 1 h for a refusal);
		// a cold start goes at once, since the retry births the actor.
		expect(sent).toEqual([
			[
				contactSyncRetryRequest(
					[{ event: notLive, reason: 'event-not-live' }] as DeferredDrovrEvent[],
					1,
					now,
				),
				{
					...contactSyncRetryRequest(
						[
							{ event: cold, reason: 'cold-start-unhandled' },
						] as DeferredDrovrEvent[],
						1,
						now,
					),
					ts: now,
				},
			],
		])
		expect((sent[0] as { ts: number }[])[0]?.ts).toBe(now + 60 * 60 * 1000)
		expect(receipt).toMatchObject({ accepted: 1, deferred: 2 })
	})

	it('keeps other bulk sources on the default delivery (no deferral)', async () => {
		mocks.fanOutOwnedEvents.mockImplementation((events: unknown[]) => events)
		const ingest = [
			event('org-aihero', 'directory:seed:contact-z', 'contact-directory'),
		]
		await registeredBulk.handler({
			events: [{ data: { events: ingest, source: 'kit-directory-ingest' } }],
			step: createStep(),
		})
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledWith({
			events: ingest,
			config: {
				ingestUrl: 'https://drovr.test/events',
				apiKey: 'authority-key',
			},
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

	it('leaves a rejected directory stop an ordinary rejection', async () => {
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
			rejected: 1,
			discarded: 0,
		})
	})
})
