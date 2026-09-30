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
	capture: vi.fn(),
	openStops: vi.fn(),
	settle: vi.fn(),
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
vi.mock('@/lib/subscriber-marketing/drovr-outbox-live', () => ({
	captureDrovrOutboxLive: mocks.capture,
	openDrovrOutboxStopsLive: mocks.openStops,
	settleDrovrOutboxLive: mocks.settle,
}))

import { contactSyncRetryRequest } from '@/lib/subscriber-marketing/contact-sync-straggler-retry'
import type { DeferredDrovrEvent } from '@/lib/subscriber-marketing/drovr-shadow-delivery'

import {
	deliverEventNameFor,
	type DrovrDeliverySource,
} from '@/inngest/events/drovr'

import {
	drovrEventsDeliver,
	drovrEventsDeliverBulk,
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
	'kit-directory-ingest',
	'contact-profile-sync',
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
	mocks.openStops.mockResolvedValue([])
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
	it('never puts a live single-contact path behind the bulk throttle: only the three bulk sources reach the throttled function (the hawk, 201g)', () => {
		expect(everySourceListed).toBe(true)
		const bulk = DELIVERY_SOURCES.filter(
			(source) => deliverEventNameFor(source) === 'drovr/events.deliver.bulk',
		)
		expect(bulk).toEqual([
			'kit-directory-ingest',
			'contact-sync-backfill',
			'evergreen-pitch-backfill',
		])
		// Signups, Kit webhooks (a DOI confirm, an unsubscribe), captured
		// purchases and every other live fact go to the live function, which
		// has its own queue and no throttle, so a running backfill of any
		// size waits alone. Inngest throttles per function.
		expect(registered.trigger).toEqual({ event: 'drovr/events.deliver' })
		expect(registered.config.throttle).toBeUndefined()
	})

	it('paces the bulk lane at 7 runs a minute of up to 100 events, 700 a minute, and never the live lane (row 201g)', () => {
		expect(registeredBulk.config.throttle).toEqual({ limit: 7, period: '1m' })
		const perMinute =
			registeredBulk.config.throttle!.limit *
			registeredBulk.config.batchEvents!.maxSize
		expect(perMinute).toBe(700)
		expect(perMinute).toBeLessThanOrEqual(750)
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
			// One instant: the birth goes first (row 204b's delivery order).
			events: [authorityEvents[1], authorityEvents[0]],
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
		mocks.capture.mockImplementation(async (entries: unknown[]) => ({
			status: 'outboxed',
			count: entries.length,
		}))
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
			const receipt = await registeredBulk.handler({
				events: [{ data: { source: 'kit-directory-ingest', events: chunk } }],
				step: createStep(),
				...LAST,
			})
			expect(receipt).toMatchObject({ accepted: 0, outboxed: 2 })
			expect(
				(
					mocks.capture.mock.calls[0]![0] as {
						idempotencyKey: string
						source: string
					}[]
				).map((entry) => [entry.idempotencyKey, entry.source]),
			).toEqual([
				['kit:birth:1', 'bulk'],
				['kit:birth:2', 'bulk'],
			])
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
				source: 'onFailure',
				needsFanOut: true,
			}),
			expect.objectContaining({
				idempotencyKey: 'owner:answer',
				source: 'onFailure',
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

	it('never outboxes a bulk source from the live onFailure', async () => {
		await outboxFailedRun(
			{
				source: 'kit-directory-ingest',
				events: [event('org-aihero', 'kit:birth:1')],
			} as never,
			new Error('boom'),
			mocks.capture,
		)
		expect(mocks.capture).not.toHaveBeenCalled()
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
		mocks.capture.mockImplementation(async (entries: unknown[]) => ({
			status: 'outboxed',
			count: entries.length,
		}))
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

	it('gates the bulk lane too', async () => {
		mocks.openStops.mockResolvedValue([owedPurchase])
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: unknown[] }) => ({
				accepted: events.length,
				rejected: 0,
			}),
		)
		const receipt = await registeredBulk.handler({
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

	it("captures a live stop on its first failure, due when Inngest's retries run out; a fact is not captured early", async () => {
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
		await expect(run([fact('owner:answer', 10)])).rejects.toMatchObject({
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

	it('records a stop drovr refused on a retry as refused, not delivered (round 3 nit)', async () => {
		mocks.deliverOrThrow.mockResolvedValue({ status: 'rejected' })
		await run([stopEvent('owner:purchase', 'purchase.recorded', 10)], {
			attempt: 3,
			maxAttempts: 9,
		})
		expect(mocks.settle).toHaveBeenCalledWith(
			[expect.objectContaining({ idempotencyKey: 'owner:purchase' })],
			'refused by drovr on an Inngest retry: final, counted rejected',
		)
	})

	it("records a bulk chunk's stops by what its retry's answer says", async () => {
		const bulk = (attempt: number) =>
			registeredBulk.handler({
				events: [
					{
						data: {
							source: 'kit-directory-ingest',
							events: [
								stopEvent('owner:unsubscribe', 'contact.unsubscribed', 10),
							],
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
		mocks.deliverBatchOrThrow.mockResolvedValue({ accepted: 0, rejected: 1 })
		await bulk(2)
		expect(mocks.settle).toHaveBeenLastCalledWith(
			[expect.objectContaining({ idempotencyKey: 'owner:unsubscribe' })],
			'settled by an Inngest retry: its chunk was answered, and drovr refused 1 item(s), final and counted rejected',
		)
	})

	it("captures only a bulk chunk's stops on its first failure", async () => {
		mocks.deliverBatchOrThrow.mockRejectedValue(drovrFailure(503))
		await expect(
			registeredBulk.handler({
				events: [
					{
						data: {
							source: 'kit-directory-ingest',
							events: [
								fact('owner:answer', 20),
								stopEvent('owner:unsubscribe', 'contact.unsubscribed', 10),
							],
						},
					},
				],
				step: createStep(),
				attempt: 0,
				maxAttempts: 9,
			}),
		).rejects.toMatchObject({ name: 'RetryAfterError' })
		expect(
			(mocks.capture.mock.calls[0]![0] as { idempotencyKey: string }[]).map(
				(e) => e.idempotencyKey,
			),
		).toEqual(['owner:unsubscribe'])
	})

	it('holds a later fact listed in an earlier bulk chunk behind a stop listed last (time order across chunks)', async () => {
		const fillers = Array.from({ length: 99 }, (_, i) =>
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
		const receipt = await registeredBulk.handler({
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
		).toContain('by-time:batch:org-aihero:0')
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
		const fillers = Array.from({ length: 99 }, (_, i) =>
			fact(`owner:filler-${i}`, 15, `contact-f${i}`),
		)
		mocks.deliverBatchOrThrow.mockImplementation(
			async ({ events }: { events: { idempotencyKey: string }[] }) => {
				if (events.some((e) => e.idempotencyKey === 'owner:purchase'))
					throw drovrFailure(503)
				return { accepted: events.length, rejected: 0 }
			},
		)
		const receipt = await registeredBulk.handler({
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
		// Chunk 0 (the stop and 99 others) is outboxed whole; chunk 1 held only
		// the later fact, so it is never posted and goes to the outbox too.
		expect(mocks.deliverBatchOrThrow).toHaveBeenCalledOnce()
		expect(receipt).toMatchObject({
			accepted: 0,
			outboxed: 101,
			heldBehindStop: 1,
		})
		expect(
			(mocks.capture.mock.calls.at(-1)![0] as { idempotencyKey: string }[]).map(
				(e) => e.idempotencyKey,
			),
		).toEqual(['owner:later'])
	})
})
