import { describe, expect, it, vi } from 'vitest'

import {
	birthThenRedeliver,
	createDirectoryBirth,
	directoryBirthEvents,
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
import { deliverBatchOrThrow } from './drovr-shadow-delivery'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import { drovrStopVerdict } from './drovr-stop-verdict'
import type { ContactRecord } from './types'

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
	other: directoryEvent('contact.tag-applied' as never),
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

	describe('an unsubscribed contact', () => {
		for (const code of codes)
			for (const kind of ['profile', 'links', 'offer'] as const)
				it(`${code ?? 'other'} × ${kind} is held when the code is a refusal we know`, () => {
					expect(drovrRefusalOutcome({ code, kind, unsubscribed: true })).toBe(
						code ? 'hold' : 'final',
					)
				})

		it('unsubscribed × cold-start-never-born: no birth, no retry (held, counted)', () => {
			const outcome = drovrRefusalOutcome({
				code: 'cold-start-never-born',
				kind: 'profile',
				unsubscribed: true,
			})
			expect(outcome).toBe('hold')
			expect(outcome).not.toBe('birth-then-redeliver')
			expect(outcome).not.toBe('retry-later')
		})

		it('does not hold a stop or a birth: they still flow', () => {
			for (const kind of ['stop', 'created'] as const)
				expect(
					drovrRefusalOutcome({
						code: 'cold-start-unhandled',
						kind,
						unsubscribed: true,
					}),
				).toBe('birth-then-redeliver')
		})
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
		journeyId: 'value-path-skills-course',
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
			'value-path-skills-course',
			'crash-course-evergreen-offer',
			'ai-hero-shadow-newsletter',
		])
			expect(births.map((b) => b.journeyId)).not.toContain(sending)
	})

	it('births provisional, with no stop lifecycle, whatever the source says', () => {
		for (const sourceLifecycle of [
			'nurture-ready',
			'new',
			'stale',
			'suppressed',
			'unsubscribed',
			'bounced',
		]) {
			const [birth] = directoryBirthEvents({
				contact: { ...contact, lifecycle: sourceLifecycle } as never,
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

// The delivery function a fleet sends from: the profile sync snapshot reads
// 'unsubscribed' from the same standing live personalize uses.
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
		repository.createContactEvent({
			...[...repository.contactEvents.values()][0]!,
			eventType: 'contact.unsubscribed',
			occurredAt: '2026-09-26T17:45:00.000Z',
			semanticIdempotencyKey: 'test:unsubscribed',
		} as never)
		expect((await read())?.unsubscribed).toBe(true)
	})
})

describe('the send log names its caller', () => {
	const profile = eventOfKind.profile
	const accepted = () => itemAnswer([{ status: 'accepted' }])

	it('stamps caller, count and status on the batch send', async () => {
		for (const caller of [
			'contact-sync',
			'straggler-retry',
			'birth-redeliver',
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
