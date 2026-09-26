import { describe, expect, it, vi } from 'vitest'

import { DROVR_CONTACT_PROFILE_SYNC_EVENT } from '@/inngest/events/drovr'

import {
	buildContactProfileEvents,
	buildValuePathJourneyLinks,
	contactProfileContentHash,
	kitIdentityOf,
	offerProfileSyncRequests,
	readContactProfileSnapshot,
	requestContactProfileSyncSafely,
	type ContactProfileSnapshot,
	CONTACT_PROFILE_HOLDS,
	contactProfileHolds,
	parseDrovrProfileSyncConfig,
	splitSendTimeFields,
} from './drovr-contact-profile-sync'
import {
	findEvergreenOffer,
	type DrovrPersonalizeRepository,
} from './drovr-personalize'
import type { ContactRecord, ContactState, SideEffectIntent } from './types'
import { personalizeValuePathEmailWithAnchoredLinks } from './value-path-email-executor'
import { createMemoryValuePathLinkAnchorStore } from './value-path-link-anchor'

const occurredAt = '2026-09-26T17:00:00.000Z'

describe('contact profile sync: the events drovr stores', () => {
	it('ships off: only true or 1 turns it on', () => {
		expect(parseDrovrProfileSyncConfig({})).toEqual({
			enabled: false,
			reason: 'AIH_DROVR_PROFILE_SYNC is not set',
		})
		for (const value of ['false', '0', 'on', 'yes', ' '])
			expect(
				parseDrovrProfileSyncConfig({ AIH_DROVR_PROFILE_SYNC: value }).enabled,
			).toBe(false)
		for (const value of ['true', '1', ' TRUE '])
			expect(
				parseDrovrProfileSyncConfig({ AIH_DROVR_PROFILE_SYNC: value }),
			).toEqual({ enabled: true })
	})

	it('holds are the five reasons that stop a send without being a suppression', () => {
		expect(CONTACT_PROFILE_HOLDS).toEqual([
			'stale-state',
			'identity-conflict',
			'support-intent',
			'team-sales-intent',
			'contact-email-missing',
		])
		// Suppressions have drovr's own rows (#324); they are not holds.
		expect(
			contactProfileHolds([
				'unsubscribed',
				'support-intent',
				'suppressed',
				'stale-state',
				'bounced',
				'complained',
				'support-intent',
			]),
		).toEqual(['stale-state', 'support-intent'])
	})

	it('addresses every event to org-aihero / contact-directory with the agreed keys', () => {
		const events = buildContactProfileEvents({
			contactId: 'contact-1',
			profileVersion: 7,
			occurredAt,
			profile: {
				email: 'learner@example.test',
				firstName: 'Ada',
				holds: ['support-intent'],
			},
			links: [
				{
					journeyId: 'value-path-skills-course',
					emailKey: 'ai-hero-skills-workflow.email-2',
					issuedAt: '2026-09-26T16:49:05.594Z',
					expiresAt: '2027-01-24T16:49:05.594Z',
					variables: { aih_value_path_answer_1_url: 'https://x.test/a' },
					sendTimeFields: [],
				},
			],
			offers: [
				{
					journeyId: 'crash-course-evergreen-offer',
					couponId: 'coupon-9',
					variables: { aih_offer_url: 'https://x.test/o' },
				},
			],
		})
		expect(events).toEqual([
			{
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'contact-directory',
				type: 'contact.profile.updated',
				occurredAt,
				idempotencyKey: 'profile:contact-1:7',
				payload: {
					profileVersion: 7,
					email: 'learner@example.test',
					firstName: 'Ada',
					holds: ['support-intent'],
				},
			},
			{
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'contact-directory',
				type: 'contact.links.issued',
				occurredAt,
				idempotencyKey:
					'links:contact-1:value-path-skills-course:ai-hero-skills-workflow.email-2:2026-09-26T16:49:05.594Z',
				payload: {
					profileVersion: 7,
					journeyId: 'value-path-skills-course',
					emailKey: 'ai-hero-skills-workflow.email-2',
					issuedAt: '2026-09-26T16:49:05.594Z',
					expiresAt: '2027-01-24T16:49:05.594Z',
					variables: { aih_value_path_answer_1_url: 'https://x.test/a' },
					sendTimeFields: [],
				},
			},
			{
				tenantId: 'org-aihero',
				contactId: 'contact-1',
				journeyId: 'contact-directory',
				type: 'contact.offer.issued',
				occurredAt,
				idempotencyKey: 'offer:contact-1:coupon-9',
				payload: {
					profileVersion: 7,
					journeyId: 'crash-course-evergreen-offer',
					variables: { aih_offer_url: 'https://x.test/o' },
				},
			},
		])
	})

	it('names the send-time stamps drovr fills with the send dueAt, and keeps them out of the stored variables', () => {
		expect(
			splitSendTimeFields({
				aih_course_started_at: '2026-09-26T17:00:00.000Z',
				aih_value_path_answer_1_url: 'https://x.test/a',
			}),
		).toEqual({
			variables: { aih_value_path_answer_1_url: 'https://x.test/a' },
			sendTimeFields: ['aih_course_started_at'],
		})
		expect(
			splitSendTimeFields({
				aih_course_completed_at: '2026-09-26T17:00:00.000Z',
				aih_value_path_certificate_url: 'https://x.test/c',
			}),
		).toEqual({
			variables: { aih_value_path_certificate_url: 'https://x.test/c' },
			sendTimeFields: ['aih_course_completed_at'],
		})
	})
})

describe('contact profile sync: journey links', () => {
	const answerPage = (emailId: string, position: number) => ({
		id: `answer-${emailId}-${position}`,
		type: 'value-path-page' as const,
		fields: {
			kind: 'answer' as const,
			slug: `${emailId}-choice-${position}`,
			sequenceId: 'ai-hero-skills-workflow',
			emailId,
			position,
			optionValue: `option-${position}`,
		},
	})
	// Every email links answers except email-6 (content complete), as in prod.
	const answerPages = [
		answerPage('email-0', 1),
		answerPage('email-1', 1),
		answerPage('email-2', 1),
		answerPage('email-2', 2),
		answerPage('email-3', 1),
		answerPage('email-4', 1),
		answerPage('email-5', 1),
		answerPage('email-7', 1),
	]
	const base = {
		contactId: 'contact-1',
		kitSubscriberId: 'kit-1',
		valuePathSlug: 'ai-hero-skills-workflow',
		answerPages,
		baseUrl: 'https://www.aihero.dev',
		pathTokenSecret: 'test-secret',
	}

	it('issues every email of the path eagerly, each with a link window', async () => {
		const linkAnchors = createMemoryValuePathLinkAnchorStore()
		const links = await buildValuePathJourneyLinks({
			...base,
			linkAnchors,
			now: '2026-09-26T17:00:00.000Z',
		})
		expect(links.map((link) => link.emailKey)).toEqual(
			[0, 1, 2, 3, 4, 5, 6, 7].map(
				(index) => `ai-hero-skills-workflow.email-${index}`,
			),
		)
		for (const link of links) {
			expect(link.journeyId).toBe('value-path-skills-course')
			expect(link.issuedAt).toBe('2026-09-26T17:00:00.000Z')
			expect(link.expiresAt).toBe('2027-01-24T17:00:00.000Z')
		}
		expect(links[0]?.sendTimeFields).toEqual(['aih_course_started_at'])
		expect(links[7]?.sendTimeFields).toEqual(['aih_course_completed_at'])
		expect(links[2]?.sendTimeFields).toEqual([])
		expect(Object.keys(links[2]?.variables ?? {})).toContain(
			'aih_value_path_answer_2_url',
		)
	})

	it("matches live personalize at a later dueAt in the same window, stamps aside (drovr's shadow compare)", async () => {
		const linkAnchors = createMemoryValuePathLinkAnchorStore()
		const links = await buildValuePathJourneyLinks({
			...base,
			linkAnchors,
			now: '2026-09-26T17:00:00.000Z',
		})
		const dueAt = '2026-10-20T09:30:00.000Z'
		for (const link of links) {
			const live = await personalizeValuePathEmailWithAnchoredLinks({
				...base,
				emailResourceId: link.emailKey,
				now: dueAt,
				linkAnchors,
			})
			expect(live.passed).toBe(true)
			const rendered = { ...link.variables }
			for (const key of link.sendTimeFields) rendered[key] = dueAt
			expect(rendered).toEqual(live.fields)
		}
	})

	it('skips an email whose personalization would be held, and never anchors it', async () => {
		const linkAnchors = createMemoryValuePathLinkAnchorStore()
		const insert = vi.spyOn(linkAnchors, 'insert')
		const links = await buildValuePathJourneyLinks({
			...base,
			// email-3 has two answers without positions: held.
			answerPages: [
				...answerPages.filter((page) => page.fields.emailId !== 'email-3'),
				{
					...answerPage('email-3', 1),
					fields: { ...answerPage('email-3', 1).fields, position: undefined },
				},
				{
					...answerPage('email-3', 2),
					fields: { ...answerPage('email-3', 2).fields, position: undefined },
				},
			],
			linkAnchors,
			now: '2026-09-26T17:00:00.000Z',
		})
		expect(links.map((link) => link.emailKey)).not.toContain(
			'ai-hero-skills-workflow.email-3',
		)
		expect(links).toHaveLength(7)
		expect(insert).toHaveBeenCalledTimes(7)
		expect(insert.mock.calls.map(([key]) => key.emailResourceId)).not.toContain(
			'ai-hero-skills-workflow.email-3',
		)
	})

	it('issues nothing for an email whose anchor store is unavailable (drovr then asks live)', async () => {
		const links = await buildValuePathJourneyLinks({
			...base,
			linkAnchors: {
				find: async () => {
					throw new Error('store down')
				},
				insert: async () => 'inserted',
			},
			now: '2026-09-26T17:00:00.000Z',
		})
		expect(links).toEqual([])
	})
})

describe('contact profile sync: one contact snapshot', () => {
	const now = '2026-09-26T17:00:00.000Z'
	const contact: ContactRecord = {
		id: 'contact-1',
		email: ' Ada@Example.TEST ',
		name: 'Ada Lovelace',
		lifecycle: 'nurture-ready',
		isProvisional: false,
		createdAt: now,
		updatedAt: now,
	}
	const state = {
		id: 'state-1',
		contactId: 'contact-1',
		lifecycle: 'nurture-ready',
		reviewSignals: [] as string[],
	} as unknown as ContactState
	const answerPages = [0, 1, 2, 3, 4, 5, 7].map((index) => ({
		id: `answer-${index}`,
		type: 'value-path-page' as const,
		fields: {
			kind: 'answer' as const,
			slug: `email-${index}-choice`,
			sequenceId: 'ai-hero-skills-workflow',
			emailId: `email-${index}`,
			position: 1,
		},
	}))
	function repository(
		overrides: {
			state?: ContactState
			unsubscribed?: number
			coupon?: SideEffectIntent
		} = {},
	): DrovrPersonalizeRepository {
		return {
			findContactById: (id) => (id === contact.id ? contact : undefined),
			findCurrentContactState: () => overrides.state ?? state,
			findContactEventsByType: (_, type) =>
				type === 'contact.unsubscribed'
					? Array(overrides.unsubscribed ?? 0).fill({})
					: [],
			findValuePathEmailSideEffectIntentsByContact: () => [],
			findSideEffectIntentByIdempotencyKey: (key) =>
				key === 'contact:contact-1:evergreen:coupon'
					? overrides.coupon
					: undefined,
		}
	}
	const read = (
		repo: DrovrPersonalizeRepository,
		extra: { valuePathSlug?: string; identityConflict?: boolean } = {},
	) =>
		readContactProfileSnapshot({
			repository: repo,
			contactId: 'contact-1',
			kitIdentity: {
				kitSubscriberId: 'kit-1',
				identityConflict: extra.identityConflict ?? false,
			},
			valuePathSlug: extra.valuePathSlug,
			answerPages,
			baseUrl: 'https://www.aihero.dev',
			pathTokenSecret: 'test-secret',
			linkAnchors: createMemoryValuePathLinkAnchorStore(),
			now,
		})

	it('answers undefined for a contact ai-hero does not have', async () => {
		await expect(
			readContactProfileSnapshot({
				repository: repository(),
				contactId: 'nobody',
				kitIdentity: { identityConflict: false },
				answerPages,
				baseUrl: 'https://www.aihero.dev',
				pathTokenSecret: 'test-secret',
				linkAnchors: createMemoryValuePathLinkAnchorStore(),
				now,
			}),
		).resolves.toBeUndefined()
	})

	it('profiles the contact exactly as live personalize addresses it, and issues the path eagerly', async () => {
		const snapshot = await read(repository(), {
			valuePathSlug: 'ai-hero-skills-workflow',
		})
		expect(snapshot?.profile).toEqual({
			email: 'ada@example.test',
			firstName: 'Ada',
			holds: [],
		})
		expect(snapshot?.links).toHaveLength(8)
		expect(snapshot?.offers).toEqual([])
		expect(snapshot?.occurredAt).toBe(now)
	})

	it('issues no links without a path to issue', async () => {
		const snapshot = await read(repository())
		expect(snapshot?.links).toEqual([])
	})

	it('carries holds, and issues no links (so no first issue) for a contact that cannot be sent', async () => {
		const held = await read(
			repository({
				state: { ...state, reviewSignals: ['support'] } as ContactState,
			}),
			{ valuePathSlug: 'ai-hero-skills-workflow', identityConflict: true },
		)
		expect(held?.profile.holds).toEqual(['identity-conflict', 'support-intent'])
		expect(held?.links).toEqual([])
		const unsubscribed = await read(repository({ unsubscribed: 1 }), {
			valuePathSlug: 'ai-hero-skills-workflow',
		})
		// A suppression is drovr's own row, not a hold; it still issues nothing.
		expect(unsubscribed?.profile.holds).toEqual([])
		expect(unsubscribed?.links).toEqual([])
	})

	it('carries the issued evergreen offer with the fields live personalize answers', async () => {
		const coupon = {
			id: 'intent-coupon',
			contactId: 'contact-1',
			status: 'completed',
			metadata: {
				couponId: 'coupon-9',
				// The personalize suite's offer shape.
				offer: {
					productId: 'product-ma254',
					amountOffCents: 10000,
					maxUses: 1,
					exclusive: true,
					regularPriceCents: 29900,
					effectivePriceCents: 19900,
					issueAt: now,
					expiresAt: '2026-10-03T09:59:59.000Z',
					timezone: 'Pacific/Kiritimati',
					timezoneSource: 'fallback',
				},
			},
		} as unknown as SideEffectIntent
		const repo = repository({ coupon })
		const snapshot = await read(repo)
		const live = await findEvergreenOffer({
			repository: repo,
			contactId: 'contact-1',
			origin: 'https://www.aihero.dev',
		})
		expect(live).toBeDefined()
		expect(snapshot?.offers).toEqual([
			{
				journeyId: 'crash-course-evergreen-offer',
				couponId: 'coupon-9',
				variables: live?.variables,
			},
		])
	})
})

describe('contact profile sync: requests', () => {
	it('asks for nothing while the flag is off, and never throws into the caller', async () => {
		const send = vi.fn(async () => undefined)
		requestContactProfileSyncSafely(
			{ contactId: 'contact-1', reason: 'journey-entered' },
			{ env: {}, send },
		)
		expect(send).not.toHaveBeenCalled()
		requestContactProfileSyncSafely(
			{ contactId: 'contact-1', reason: 'journey-entered' },
			{ env: { AIH_DROVR_PROFILE_SYNC: 'true' }, send },
		)
		expect(send).toHaveBeenCalledWith({
			name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
			data: { contactId: 'contact-1', reason: 'journey-entered' },
		})
		expect(() =>
			requestContactProfileSyncSafely(
				{ contactId: 'contact-1', reason: 'journey-entered' },
				{
					env: { AIH_DROVR_PROFILE_SYNC: 'true' },
					send: () => {
						throw new Error('inngest down')
					},
				},
			),
		).not.toThrow()
	})

	it('asks for one offer sync per coupon issued in a sender run, only while on', () => {
		const results = [
			{
				status: 'completed' as const,
				intentId: 'i1',
				contactId: 'c1',
				couponId: 'k1',
			},
			{ status: 'retry' as const, intentId: 'i2', attempts: 1, error: 'x' },
			{
				status: 'completed' as const,
				intentId: 'i3',
				contactId: 'c3',
				couponId: 'k3',
			},
			{ status: 'failed' as const, intentId: 'i4', error: 'x' },
		]
		expect(
			offerProfileSyncRequests(results, { enabled: false, reason: 'off' }),
		).toEqual([])
		expect(offerProfileSyncRequests(results, { enabled: true })).toEqual([
			{
				name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
				data: { contactId: 'c1', reason: 'offer-issued' },
			},
			{
				name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
				data: { contactId: 'c3', reason: 'offer-issued' },
			},
		])
	})

	it('reads one Kit identity as the subscriber, and two as a conflict with none chosen', () => {
		expect(kitIdentityOf([])).toEqual({ identityConflict: false })
		expect(kitIdentityOf(['kit-1'])).toEqual({
			kitSubscriberId: 'kit-1',
			identityConflict: false,
		})
		expect(kitIdentityOf(['kit-1', 'kit-2'])).toEqual({
			identityConflict: true,
		})
	})
})

describe('contact profile content hash', () => {
	const snapshot: ContactProfileSnapshot = {
		occurredAt: '2026-09-26T17:00:00.000Z',
		profile: { email: 'a@example.test', firstName: 'Ada', holds: [] },
		links: [
			{
				journeyId: 'value-path-skills-course',
				emailKey: 'ai-hero-skills-workflow.email-1',
				issuedAt: '2026-09-26T16:00:00.000Z',
				expiresAt: '2027-01-24T16:00:00.000Z',
				variables: { a: '1' },
				sendTimeFields: [],
			},
			{
				journeyId: 'value-path-skills-course',
				emailKey: 'ai-hero-skills-workflow.email-0',
				issuedAt: '2026-09-26T16:00:00.000Z',
				expiresAt: '2027-01-24T16:00:00.000Z',
				variables: { b: '2' },
				sendTimeFields: ['aih_course_started_at'],
			},
		],
		offers: [],
	}

	it('ignores when the snapshot was read and the order links come in', () => {
		const laterReversed: ContactProfileSnapshot = {
			...snapshot,
			occurredAt: '2026-09-26T19:00:00.000Z',
			links: [...snapshot.links].reverse(),
		}
		expect(contactProfileContentHash(laterReversed)).toBe(
			contactProfileContentHash(snapshot),
		)
		expect(contactProfileContentHash(snapshot)).toMatch(/^[0-9a-f]{64}$/)
	})

	it('changes with any hold, address, name, link window or offer', () => {
		const base = contactProfileContentHash(snapshot)
		for (const changed of [
			{
				...snapshot,
				profile: { ...snapshot.profile, holds: ['support-intent'] },
			},
			{
				...snapshot,
				profile: { ...snapshot.profile, email: 'b@example.test' },
			},
			{ ...snapshot, profile: { ...snapshot.profile, firstName: null } },
			{
				...snapshot,
				links: [
					{ ...snapshot.links[0]!, issuedAt: '2026-12-25T16:00:00.000Z' },
					snapshot.links[1]!,
				],
			},
			{
				...snapshot,
				offers: [
					{
						journeyId: 'crash-course-evergreen-offer',
						couponId: 'k1',
						variables: { o: '1' },
					},
				],
			},
		])
			expect(contactProfileContentHash(changed)).not.toBe(base)
	})
})
