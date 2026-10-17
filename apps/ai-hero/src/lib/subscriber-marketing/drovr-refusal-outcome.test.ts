import { describe, expect, it, vi } from 'vitest'

import {
	birthThenRedeliver,
	createDirectoryBirth,
	directoryBirthEvents,
	contactSyncRetryRequest,
	runContactSyncStragglerRetry,
} from './contact-sync-straggler-retry'
import { runContactProfileSync } from './drovr-contact-profile-sync'
import {
	drovrDeferralReasonOf,
	drovrEventKind,
	drovrRefusalOutcome,
	drovrRefusalCodeOf,
	splitUnsubscribedHolds,
	type DrovrEventKind,
	type DrovrRefusalCode,
	type DrovrRefusalOutcome,
} from './drovr-refusal-outcome'
import { readContactSendStanding } from './drovr-personalize'
import {
	deliverBatchOrThrow,
	type DrovrBatchOutcome,
} from './drovr-shadow-delivery'
import {
	deliverHoldingUnsubscribed,
	HELD_KEYS_LOGGED,
	isUnsubscribedForHold,
} from './drovr-straggler-hold'
import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import { drovrStopVerdict } from './drovr-stop-verdict'
import type { ContactLifecycle, ContactRecord } from './types'

const config = { ingestUrl: 'https://drovr.test/events', apiKey: 'test-key' }
const at = '2026-10-01T10:00:00.000Z'

const directoryEvent = (
	type: DrovrShadowEvent['type'],
	contactId = 'c1',
): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	contactId,
	journeyId: 'contact-directory',
	type,
	occurredAt: at,
	idempotencyKey: `${type}:${contactId}`,
})

const eventOfKind: Record<DrovrEventKind, DrovrShadowEvent> = {
	stop: directoryEvent('contact.unsubscribed'),
	profile: directoryEvent('contact.profile.updated'),
	links: directoryEvent('contact.links.issued'),
	offer: directoryEvent('contact.offer.issued'),
	created: directoryEvent('contact.created'),
	other: directoryEvent('coupon.issued'),
}

const neverBornDetail = (c = 'c1') =>
	`{"code":"cold-start-never-born","error":"Contact ${c} has no actor on journey contact-directory; refusing the cold start"}`

const itemAnswer = (results: { status: string; detail?: string }[]) =>
	vi.fn().mockResolvedValue(
		new Response(
			JSON.stringify({
				accepted: results.filter((r) => r.status === 'accepted').length,
				rejected: results.filter((r) => r.status === 'rejected').length,
				failed: results.filter((r) => r.status === 'failed').length,
				results: results.map((r, index) => ({ index, ...r })),
			}),
			{ status: 200 },
		),
	)

describe('refusal to outcome: the whole table', () => {
	const codes: (DrovrRefusalCode | undefined)[] = [
		'event-not-live',
		'cold-start-unhandled',
		'cold-start-never-born',
		undefined, // any other code
	]
	const kinds: DrovrEventKind[] = [
		'stop',
		'profile',
		'links',
		'offer',
		'created',
		'other',
	]
	const expected = (
		code: DrovrRefusalCode | undefined,
		kind: DrovrEventKind,
	): DrovrRefusalOutcome => {
		if (code === 'event-not-live') return 'retry-later'
		if (code === 'cold-start-unhandled') return 'birth-then-redeliver'
		if (code === 'cold-start-never-born')
			return kind === 'profile' || kind === 'links' || kind === 'offer'
				? 'birth-then-redeliver'
				: 'final'
		return 'final'
	}

	for (const code of codes)
		for (const kind of kinds)
			it(`${code ?? 'other'} × ${kind} → ${expected(code, kind)}`, () => {
				expect(drovrRefusalOutcome({ code, kind })).toBe(expected(code, kind))
			})

	it('classifies event types into kinds', () => {
		for (const [kind, event] of Object.entries(eventOfKind))
			expect(drovrEventKind(event)).toBe(kind)
	})

	it('reads the code from a problem body, a problem type and a batch detail', () => {
		expect(drovrRefusalCodeOf(neverBornDetail())).toBe('cold-start-never-born')
		expect(drovrRefusalCodeOf({ code: 'cold-start-never-born' })).toBe(
			'cold-start-never-born',
		)
		expect(drovrRefusalCodeOf('event-not-live: v1 actor')).toBe(
			'event-not-live',
		)
		expect(drovrRefusalCodeOf('cold-start-unhandled: none')).toBe(
			'cold-start-unhandled',
		)
		expect(drovrRefusalCodeOf('actor busy')).toBeUndefined()
	})
})

describe('a never-born profile or link push is born, then redelivered', () => {
	const profile = directoryEvent('contact.profile.updated')
	const links = directoryEvent('contact.links.issued')

	it('hands a never-born profile, links and offer item back as cold-start-unhandled', async () => {
		const offer = directoryEvent('contact.offer.issued')
		const outcome = await deliverBatchOrThrow({
			clampAt: Date.now(),
			events: [profile, links, offer],
			config,
			fetcher: itemAnswer([
				{ status: 'rejected', detail: neverBornDetail() },
				{ status: 'rejected', detail: neverBornDetail() },
				{ status: 'rejected', detail: neverBornDetail() },
			]),
			warn: vi.fn(),
			deferNotLive: true,
		})
		expect(outcome).toEqual({
			accepted: 0,
			rejected: 0,
			deferred: [
				{ event: profile, reason: 'cold-start-unhandled' },
				{ event: links, reason: 'cold-start-unhandled' },
				{ event: offer, reason: 'cold-start-unhandled' },
			],
		})
	})

	it('does the same for a whole-envelope 409', async () => {
		const outcome = await deliverBatchOrThrow({
			clampAt: Date.now(),
			events: [profile, links],
			config,
			fetcher: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ code: 'cold-start-never-born' }), {
					status: 409,
				}),
			),
			warn: vi.fn(),
			deferNotLive: true,
		})
		expect(outcome.deferred?.map((d) => d.reason)).toEqual([
			'cold-start-unhandled',
			'cold-start-unhandled',
		])
		expect(outcome.rejected).toBe(0)
	})

	it('without deferNotLive a never-born profile stays a final reject', async () => {
		expect(
			await deliverBatchOrThrow({
				clampAt: Date.now(),
				events: [profile],
				config,
				fetcher: itemAnswer([
					{ status: 'rejected', detail: neverBornDetail() },
				]),
				warn: vi.fn(),
			}),
		).toMatchObject({ accepted: 0, rejected: 1, refused: [expect.anything()] })
	})

	it('births the directory actor, then redelivers the same events', async () => {
		const birth = vi.fn(async () => {})
		const deliver = vi.fn(async () => ({ accepted: 2, rejected: 0 }))
		const resolved = await birthThenRedeliver({
			deferred: [
				{ event: profile, reason: 'cold-start-unhandled' },
				{ event: links, reason: 'cold-start-unhandled' },
			],
			step: { run: async (_id, cb) => cb(), sendEvent: async () => {} },
			birth,
			deliver,
		})
		expect(birth).toHaveBeenCalledWith(['c1'])
		expect(deliver).toHaveBeenCalledWith([profile, links])
		expect(resolved).toEqual({ deferred: [], accepted: 2, rejected: 0 })
	})
})

describe('stops never birth', () => {
	const ownerStop: DrovrShadowEvent = {
		tenantId: 'org-aihero',
		contactId: 'c1',
		journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
		type: 'contact.unsubscribed',
		occurredAt: at,
		idempotencyKey: 'owner:aihero:contact-event:e1',
	}
	const directoryStop = eventOfKind.stop

	it('an owner stop answered never-born is released, not deferred', async () => {
		const outcome = await deliverBatchOrThrow({
			clampAt: Date.now(),
			events: [ownerStop],
			config,
			fetcher: itemAnswer([{ status: 'rejected', detail: neverBornDetail() }]),
			warn: vi.fn(),
			deferNotLive: true,
		})
		expect(outcome.deferred).toBeUndefined()
		expect(drovrDeferralReasonOf(ownerStop, neverBornDetail())).toBeUndefined()
		expect(
			drovrStopVerdict(ownerStop, {
				httpStatus: 409,
				problem: neverBornDetail(),
			}),
		).toBe('released')
	})

	it('a whole-envelope never-born 409 does not birth for an owner stop', async () => {
		const outcome = await deliverBatchOrThrow({
			clampAt: Date.now(),
			events: [ownerStop],
			config,
			fetcher: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ code: 'cold-start-never-born' }), {
					status: 409,
				}),
			),
			warn: vi.fn(),
			deferNotLive: true,
		})
		expect(outcome.deferred).toBeUndefined()
	})

	it('a directory stop answered never-born is refused, not born', async () => {
		const outcome = await deliverBatchOrThrow({
			clampAt: Date.now(),
			events: [directoryStop],
			config,
			fetcher: itemAnswer([{ status: 'rejected', detail: neverBornDetail() }]),
			warn: vi.fn(),
			deferNotLive: true,
		})
		expect(outcome.deferred).toBeUndefined()
		expect(outcome.refused).toHaveLength(1)
	})

	it('in a mixed chunk only the profile push is born', async () => {
		const profile = eventOfKind.profile
		const outcome = await deliverBatchOrThrow({
			clampAt: Date.now(),
			events: [profile, ownerStop],
			config,
			fetcher: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ code: 'cold-start-never-born' }), {
					status: 409,
				}),
			),
			warn: vi.fn(),
			deferNotLive: true,
		})
		expect(outcome.deferred).toEqual([
			{ event: profile, reason: 'cold-start-unhandled' },
		])
		expect(outcome.refused?.map((r) => r.event)).toEqual([ownerStop])
	})
})

describe('births are idempotent and send nothing by themselves', () => {
	const contact: ContactRecord = {
		id: 'c1',
		lifecycle: 'nurture-ready',
		isProvisional: false,
		createdAt: '2026-09-01T10:00:00.000Z',
		updatedAt: '2026-09-02T10:00:00.000Z',
	}

	it('two events racing for one never-born contact produce one birth, keyed on the contact', async () => {
		const profile = eventOfKind.profile
		const links = eventOfKind.links
		const birth = vi.fn(async () => {})
		await birthThenRedeliver({
			deferred: [
				{ event: profile, reason: 'cold-start-unhandled' },
				{ event: links, reason: 'cold-start-unhandled' },
			],
			step: { run: async (_id, cb) => cb(), sendEvent: async () => {} },
			birth,
			deliver: async () => ({ accepted: 2, rejected: 0 }),
		})
		expect(birth).toHaveBeenCalledTimes(1)
		expect(birth).toHaveBeenCalledWith(['c1'])
	})

	it('two racing runs post the same birth key, which drovr dedupes', async () => {
		const posted: DrovrShadowEvent[] = []
		const run = createDirectoryBirth({
			findContactById: async () => contact,
			kitSubscriberIdFor: async () => undefined,
			deliver: async (events) => {
				posted.push(...events)
			},
		})
		await Promise.all([run(['c1']), run(['c1'])])
		expect(new Set(posted.map((e) => e.idempotencyKey))).toEqual(
			new Set(['directory:seed:c1']),
		)
	})

	it('births to contact-directory only, never a sending journey', () => {
		const births = directoryBirthEvents({ contact })
		expect(births).toHaveLength(1)
		for (const birth of births) {
			expect(birth.journeyId).toBe('contact-directory')
			expect(birth.type).toBe('contact.created')
			expect(birth.tenantId).toBe('org-aihero')
		}
		for (const sending of [
			DROVR_SKILLS_COURSE_JOURNEY_ID,
			DROVR_EVERGREEN_OFFER_JOURNEY_ID,
			DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
		])
			expect(births.map((b) => b.journeyId)).not.toContain(sending)
	})

	it('births provisional, with no stop lifecycle, whatever the source says', () => {
		const lifecycles: ContactLifecycle[] = [
			'new',
			'classified',
			'nurture-ready',
			'human-review',
			'suppressed',
			'customer',
			'stale',
		]
		for (const sourceLifecycle of lifecycles) {
			const [birth] = directoryBirthEvents({
				contact: { ...contact, lifecycle: sourceLifecycle },
			})
			expect(birth?.payload).toMatchObject({ lifecycle: 'provisional' })
			expect(birth?.payload).not.toMatchObject({ lifecycle: 'unsubscribed' })
			expect(birth?.payload).not.toMatchObject({ lifecycle: 'bounced' })
		}
	})
})

describe('unsubscribed contacts: profile, link and offer pushes are held', () => {
	it('holds the three pushes and lets stops and births through', async () => {
		const events = Object.values(eventOfKind)
		const { send, held } = await splitUnsubscribedHolds(
			events,
			async () => true,
		)
		expect(held.map(drovrEventKind)).toEqual(['profile', 'links', 'offer'])
		expect(send.map(drovrEventKind)).toEqual(['stop', 'created', 'other'])
	})

	it('an unsubscribed contact’s stop is never held', async () => {
		const { send, held } = await splitUnsubscribedHolds(
			[eventOfKind.stop],
			async () => true,
		)
		expect(held).toEqual([])
		expect(send).toEqual([eventOfKind.stop])
	})

	it('holds nothing for a subscribed contact, and asks once per contact', async () => {
		const asked = vi.fn(async () => false)
		const { send, held } = await splitUnsubscribedHolds(
			[eventOfKind.profile, eventOfKind.links, eventOfKind.offer],
			asked,
		)
		expect(held).toEqual([])
		expect(send).toHaveLength(3)
		expect(asked).toHaveBeenCalledTimes(1)
	})

	const syncFor = (unsubscribed: boolean) => {
		const deliver = vi.fn(async () => ({ accepted: 1, rejected: 0 }))
		const birth = vi.fn(async () => {})
		const sendEvent = vi.fn(async () => {})
		const run = runContactProfileSync({
			event: { data: { contactId: 'c1', reason: 'reconcile' } },
			step: { run: async (_id, cb) => cb(), sendEvent },
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			readSnapshot: async () => ({
				...(unsubscribed ? { unsubscribed: true as const } : {}),
				occurredAt: at,
				profile: { email: 'learner@example.test', firstName: null, holds: [] },
				links: [],
				offers: [],
			}),
			versionFor: async () => ({
				profileVersion: 1,
				since: at,
				acknowledged: false,
			}),
			deliver,
			ownedPath: async () => undefined,
			onSendingJourney: async () => true,
			birth,
			acknowledge: async () => {},
		})
		return { run, deliver, birth, sendEvent }
	}

	it('the sync pushes nothing, births nothing and schedules no retry', async () => {
		const h = syncFor(true)
		expect(await h.run).toEqual({
			status: 'skipped',
			reason: 'unsubscribed-held',
		})
		expect(h.deliver).not.toHaveBeenCalled()
		expect(h.birth).not.toHaveBeenCalled()
		expect(h.sendEvent).not.toHaveBeenCalled()
	})

	it('a subscribed contact still syncs', async () => {
		const h = syncFor(false)
		expect(await h.run).toMatchObject({ status: 'sent' })
		expect(h.deliver).toHaveBeenCalledTimes(1)
	})
})

const isHeldByRetry = (
	repository: Parameters<typeof readContactSendStanding>[0]['repository'],
	contactId: string,
) => isUnsubscribedForHold(readContactSendStanding, repository, contactId)

describe('the snapshot marks an unsubscribed contact', () => {
	it('carries unsubscribed only when the standing says so', async () => {
		const { readContactProfileSnapshot } =
			await import('./drovr-contact-profile-sync')
		const { InMemorySubscriberMarketingRepository } = await import('./dry-run')
		const { createMemoryValuePathLinkAnchorStore } =
			await import('./value-path-link-anchor')
		const { captureNormalizedContactEvent } =
			await import('./capture-contact-event')
		const { normalizeContactEvent } = await import('./normalize-contact-event')
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await captureNormalizedContactEvent({
			repository,
			event: normalizeContactEvent({
				provider: 'kit',
				providerEventId: 'signup',
				eventType: 'kit.message',
				occurredAt: '2026-09-26T17:30:00.000Z',
				email: 'learner@example.test',
				externalId: 'kit-1',
				message: 'Signed up for the skills newsletter',
			}),
		})
		const read = () =>
			readContactProfileSnapshot({
				repository,
				contactId: captured.contact.id,
				kitIdentity: { identityConflict: false },
				answerPages: [],
				baseUrl: 'https://www.aihero.dev',
				linkAnchors: createMemoryValuePathLinkAnchorStore(),
				now: '2026-09-26T18:00:00.000Z',
			})
		expect((await read())?.unsubscribed).toBeUndefined()
		// A stop event on the contact, as drovr's own stop signals read it.
		const signup = [...repository.contactEvents.values()][0]!
		repository.createContactEvent({
			...signup,
			eventType: 'contact.unsubscribed',
			occurredAt: '2026-09-26T17:45:00.000Z',
			semanticIdempotencyKey: 'test:unsubscribed',
		})
		expect((await read())?.unsubscribed).toBe(true)
		expect(await isHeldByRetry(repository, captured.contact.id)).toBe(true)
		// A fresh double opt-in lifts it: not held, in the sync and the retry.
		repository.createContactEvent({
			...signup,
			eventType: 'contact.resubscribed',
			occurredAt: '2026-09-26T17:50:00.000Z',
			semanticIdempotencyKey: 'test:resubscribed',
		})
		expect((await read())?.unsubscribed).toBeUndefined()
		expect(await isHeldByRetry(repository, captured.contact.id)).toBe(false)
	})
})

describe('the send log names its caller', () => {
	const profile = eventOfKind.profile
	const accepted = () => itemAnswer([{ status: 'accepted' }])

	it('stamps caller, count and status on the batch send', async () => {
		for (const caller of [
			'contact-sync',
			'straggler-retry',
			'directory-birth',
			'reconcile',
			'outbox-replay',
		] as const) {
			const info = vi.fn()
			await deliverBatchOrThrow({
				clampAt: Date.now(),
				events: [profile],
				config,
				fetcher: accepted(),
				warn: vi.fn(),
				info,
				caller,
			})
			expect(info).toHaveBeenCalledWith('drovr.shadow.batch_sent', {
				caller,
				count: 1,
				status: 200,
			})
		}
	})

	it('stamps the caller on a rejection warning', async () => {
		const warn = vi.fn()
		await deliverBatchOrThrow({
			clampAt: Date.now(),
			events: [profile],
			config,
			fetcher: itemAnswer([{ status: 'rejected', detail: 'bad shape' }]),
			warn,
			info: vi.fn(),
			caller: 'contact-sync',
		})
		expect(warn).toHaveBeenCalledWith(
			'drovr.shadow.rejected',
			expect.objectContaining({ caller: 'contact-sync' }),
		)
	})

	it('logs no send line when the caller is not named', async () => {
		const info = vi.fn()
		await deliverBatchOrThrow({
			clampAt: Date.now(),
			events: [profile],
			config,
			fetcher: accepted(),
			warn: vi.fn(),
			info,
		})
		expect(info).not.toHaveBeenCalledWith(
			'drovr.shadow.batch_sent',
			expect.anything(),
		)
	})
})

describe('the straggler retry closure holds unsubscribed pushes', () => {
	const profile = eventOfKind.profile
	const links = directoryEvent('contact.links.issued', 'c2')
	const stop = directoryEvent('contact.unsubscribed', 'c1')
	const make = (args: {
		unsubscribed?: (id: string) => boolean | Error
		send?: (events: DrovrShadowEvent[]) => Promise<DrovrBatchOutcome>
	}) => {
		const warn = vi.fn()
		const send = vi.fn(
			args.send ??
				(async (events) => ({ accepted: events.length, rejected: 0 })),
		)
		const deliver = deliverHoldingUnsubscribed({
			warn,
			isUnsubscribed: async (id) => {
				const answer = args.unsubscribed?.(id) ?? false
				if (answer instanceof Error) throw answer
				return answer
			},
			send,
		})
		return { deliver, send, warn }
	}

	it('sends the subscribed events by reference with their original keys', async () => {
		const events = [profile, links]
		const h = make({ unsubscribed: (id) => id === 'c1' })
		const outcome = await h.deliver(events)
		expect(h.send).toHaveBeenCalledTimes(1)
		const sent = h.send.mock.calls[0]![0]
		expect(sent).toHaveLength(1)
		expect(sent[0]).toBe(links)
		expect(sent[0]!.idempotencyKey).toBe(links.idempotencyKey)
		expect(outcome).toEqual({ accepted: 1, rejected: 1 })
	})

	it('posts nothing for an all-held chunk, and counts every event rejected', async () => {
		const h = make({ unsubscribed: () => true })
		expect(await h.deliver([profile, links])).toEqual({
			accepted: 0,
			rejected: 2,
		})
		expect(h.send).not.toHaveBeenCalled()
	})

	it('lets a stop through for an unsubscribed contact', async () => {
		const h = make({ unsubscribed: () => true })
		await h.deliver([profile, stop])
		expect(h.send).toHaveBeenCalledWith([stop])
	})

	it('adds the held count to what the send rejected', async () => {
		const h = make({
			unsubscribed: (id) => id === 'c1',
			send: async () => ({ accepted: 0, rejected: 1 }),
		})
		expect(await h.deliver([profile, links])).toMatchObject({ rejected: 2 })
	})

	it('fails open: a throwing lookup still sends (and so outboxes) the events', async () => {
		const h = make({ unsubscribed: () => new Error('db down') })
		const outcome = await h.deliver([profile, links])
		expect(h.send).toHaveBeenCalledWith([profile, links])
		expect(outcome).toEqual({ accepted: 2, rejected: 0 })
		expect(h.warn).toHaveBeenCalledWith(
			'drovr.contact_sync.hold_lookup_failed',
			expect.objectContaining({ error: 'db down' }),
		)
	})

	it('caps the held keys it logs and still reports the count', async () => {
		const many = Array.from({ length: HELD_KEYS_LOGGED + 5 }, (_, i) =>
			directoryEvent('contact.profile.updated', `h${i}`),
		)
		const h = make({ unsubscribed: () => true })
		await h.deliver(many)
		const fields = h.warn.mock.calls.find(
			([name]) => name === 'drovr.contact_sync.unsubscribed_held',
		)![1] as { held: number; idempotencyKeys: string[] }
		expect(fields.held).toBe(HELD_KEYS_LOGGED + 5)
		expect(fields.idempotencyKeys).toHaveLength(HELD_KEYS_LOGGED)
	})

	it('never acknowledges the unsent version after a hold', async () => {
		const items = [{ event: profile, reason: 'cold-start-unhandled' as const }]
		const h = make({ unsubscribed: () => true })
		const birth = vi.fn(async () => {})
		const acknowledge = vi.fn(async () => {})
		const sendEvent = vi.fn(async () => {})
		const receipt = await runContactSyncStragglerRetry({
			event: {
				data: {
					items,
					attempt: 1,
					acknowledge: { contactId: 'c1', profileVersion: 3 },
				},
			},
			step: { run: async (_id, cb) => cb(), sendEvent },
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			now: () => 0,
			deliver: h.deliver,
			warn: vi.fn(),
			birth,
			acknowledge,
		})
		expect(receipt).toEqual({ status: 'delivered', accepted: 0, rejected: 1 })
		expect(birth).not.toHaveBeenCalled()
		expect(acknowledge).not.toHaveBeenCalled()
		expect(sendEvent).not.toHaveBeenCalled()
	})
})

describe('a mixed whole-envelope refusal', () => {
	it('warns every refused event and keeps the non-deferrable ones refused', async () => {
		const ownerStop: DrovrShadowEvent = {
			tenantId: 'org-aihero',
			contactId: 'c1',
			journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
			type: 'contact.unsubscribed',
			occurredAt: at,
			idempotencyKey: 'owner:aihero:contact-event:e2',
		}
		const warn = vi.fn()
		const outcome = await deliverBatchOrThrow({
			clampAt: Date.now(),
			events: [eventOfKind.profile, ownerStop],
			config,
			fetcher: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ code: 'cold-start-never-born' }), {
					status: 409,
				}),
			),
			warn,
			deferNotLive: true,
		})
		expect(outcome.refused?.map((r) => r.event)).toEqual([ownerStop])
		expect(warn).toHaveBeenCalledWith(
			'drovr.shadow.batch_rejected',
			expect.objectContaining({ count: 1 }),
		)
	})
})

describe('one held contact does not stop the healer for the others', () => {
	it('reschedules what the send deferred, on the normal cadence, with its original key', async () => {
		const held = directoryEvent('contact.profile.updated', 'c1')
		const links = directoryEvent('contact.links.issued', 'c2')
		const send = vi.fn(async (events: DrovrShadowEvent[]) => ({
			accepted: 0,
			rejected: 0,
			deferred: events.map((event) => ({
				event,
				reason: 'event-not-live' as const,
			})),
		}))
		const deliver = deliverHoldingUnsubscribed({
			warn: vi.fn(),
			isUnsubscribed: async (id) => id === 'c1',
			send,
		})
		const sendEvent = vi.fn(async () => {})
		const now = Date.parse(at)
		const receipt = await runContactSyncStragglerRetry({
			event: {
				data: {
					items: [
						{ event: held, reason: 'event-not-live' },
						{ event: links, reason: 'event-not-live' },
					],
					attempt: 1,
				},
			},
			step: { run: async (_id, cb) => cb(), sendEvent },
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			now: () => now,
			deliver,
			warn: vi.fn(),
			birth: vi.fn(async () => {}),
			acknowledge: vi.fn(async () => {}),
		})
		expect(receipt).toMatchObject({ status: 'rescheduled', deferred: 1 })
		expect(sendEvent).toHaveBeenCalledTimes(1)
		const [, payload] = sendEvent.mock.calls[0] as unknown as [
			string,
			ReturnType<typeof contactSyncRetryRequest>,
		]
		expect(payload).toEqual(
			contactSyncRetryRequest(
				[{ event: links, reason: 'event-not-live' }],
				2,
				now,
			),
		)
		expect(payload.data.items[0]!.event.idempotencyKey).toBe(
			links.idempotencyKey,
		)
	})
})
