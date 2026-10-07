import { describe, expect, it, vi } from 'vitest'
import { verifyValuePathToken } from './path-token'
import {
	personalizeDrovrIntent,
	type DrovrPersonalizeRepository,
	type DrovrPersonalizeRequest,
} from './drovr-personalize'
import type {
	ContactEventRecord,
	ContactRecord,
	ContactState,
	SideEffectIntent,
} from './types'
import { normalizeContactEvent } from './normalize-contact-event'
import {
	OLD_NEWSLETTER_ABSENT,
	OLD_NEWSLETTER_EXIT_CONFIRMED,
	OLD_NEWSLETTER_SUBSCRIBED,
	OLD_NEWSLETTER_REFERENCE,
} from './old-newsletter-exit'
import { SHADOW_NEWSLETTER_KIT_SEQUENCES } from './drovr-shadow-newsletter'
import { DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE } from './drovr-list-subscribe'
import {
	createMemoryValuePathLinkAnchorStore,
	type ValuePathLinkAnchorStore,
} from './value-path-link-anchor'

const dueAt = '2026-09-24T18:00:00.000Z'
const request: DrovrPersonalizeRequest = {
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'value-path-skills-course',
	emailKey: 'ai-hero-skills-workflow.email-0',
	idempotencyKey: 'intent-1',
	dueAt,
}
const contact: ContactRecord = {
	id: 'contact-1',
	email: 'Ada@Example.COM',
	name: 'Ada Lovelace',
	lifecycle: 'nurture-ready',
	isProvisional: false,
	createdAt: dueAt,
	updatedAt: dueAt,
}
const state: ContactState = {
	id: 'state-1',
	contactId: 'contact-1',
	lifecycle: 'nurture-ready',
	primaryBucket: 'unknown' as never,
	allBuckets: [],
	whySignals: [],
	whoSignals: [],
	confidence: 1,
	rationale: [],
	reviewSignals: [],
	humanReview: false,
	lastEventId: 'event-1',
	schemaVersion: 1,
	updatedAt: dueAt,
}
const page = {
	id: 'answer-1',
	type: 'value-path-page' as const,
	fields: {
		kind: 'answer' as const,
		slug: 'what-next',
		sequenceId: 'ai-hero-skills-workflow',
		emailId: 'email-0',
		position: 1,
	},
}

function fixture() {
	let currentContact: ContactRecord | undefined = contact
	let currentState: ContactState | undefined = state
	let identityConflict = false
	const events = new Map<string, number>()
	const dated = new Map<string, { occurredAt: string }[]>()
	const prior: SideEffectIntent[] = []
	const coupons = new Map<string, SideEffectIntent>()
	const legacyEvents = new Map<string, ContactEventRecord[]>()
	const repository: DrovrPersonalizeRepository = {
		findContactById: () => currentContact,
		findCurrentContactState: () => currentState,
		findContactEventsByType: (_, type) =>
			(legacyEvents.get(type) ??
				dated.get(type) ??
				Array(events.get(type) ?? 0).fill({})) as never,
		findValuePathEmailSideEffectIntentsByContact: () => prior,
		findSideEffectIntentByIdempotencyKey: (key) => coupons.get(key),
	}
	return {
		repository,
		events,
		dated,
		prior,
		coupons,
		legacyEvents,
		setContact: (value: ContactRecord | undefined) => {
			currentContact = value
		},
		setState: (value: ContactState | undefined) => {
			currentState = value
		},
		setIdentityConflict: (value: boolean) => {
			identityConflict = value
		},
		answer: (
			overrides: Partial<DrovrPersonalizeRequest> = {},
			secret = 'local-test-secret',
			extra: {
				linkAnchors?: ValuePathLinkAnchorStore
				kitSubscriberId?: string
				baseUrl?: string
			} = {},
		) =>
			personalizeDrovrIntent({
				repository,
				request: { ...request, ...overrides },
				answerPages: [page],
				pathTokenSecret: secret,
				baseUrl: extra.baseUrl ?? 'https://www.aihero.dev',
				kitSubscriberId: extra.kitSubscriberId ?? 'kit-1',
				identityConflict,
				...(extra.linkAnchors ? { linkAnchors: extra.linkAnchors } : {}),
			}),
	}
}

const tokenExpiry = (href: string | undefined) =>
	verifyValuePathToken({
		token: new URL(href!).searchParams.get('pt'),
		secret: 'local-test-secret',
		expirationPolicy: 'allow-expired',
	})

describe('drovr personalization: answer links anchored at first issue', () => {
	it('gives the same contact and email the same URL on a later send, valid 120 days from its first issue', async () => {
		const f = fixture()
		const linkAnchors = createMemoryValuePathLinkAnchorStore()
		const first = await f.answer({}, 'local-test-secret', { linkAnchors })
		const later = await f.answer(
			{ dueAt: '2026-10-14T18:00:00.000Z', idempotencyKey: 'intent-2' },
			'local-test-secret',
			{ linkAnchors },
		)
		const href = first?.variables.aih_value_path_answer_1_url
		expect(href).toContain('/ask/what-next?pt=')
		expect(later?.variables.aih_value_path_answer_1_url).toBe(href)
		expect(tokenExpiry(href)).toMatchObject({
			valid: true,
			payload: { expiresAt: '2027-01-22T18:00:00.000Z' },
		})
	})

	it('re-anchors when the Kit subscriber id changes', async () => {
		const f = fixture()
		const linkAnchors = createMemoryValuePathLinkAnchorStore()
		const before = await f.answer({}, 'local-test-secret', { linkAnchors })
		const after = await f.answer(
			{ dueAt: '2026-10-14T18:00:00.000Z' },
			'local-test-secret',
			{ linkAnchors, kitSubscriberId: 'kit-2' },
		)
		expect(after?.variables.aih_value_path_answer_1_url).not.toBe(
			before?.variables.aih_value_path_answer_1_url,
		)
		expect(
			tokenExpiry(after?.variables.aih_value_path_answer_1_url),
		).toMatchObject({
			payload: {
				kitSubscriberId: 'kit-2',
				expiresAt: '2027-02-11T18:00:00.000Z',
			},
		})
	})

	it('keeps a retry byte-identical after a later send of the same email moved to the next link window', async () => {
		const f = fixture()
		const linkAnchors = createMemoryValuePathLinkAnchorStore()
		const original = await f.answer({}, 'local-test-secret', { linkAnchors })
		const later = await f.answer(
			{ dueAt: '2027-01-01T18:00:00.000Z', idempotencyKey: 'intent-2' },
			'local-test-secret',
			{ linkAnchors },
		)
		const retry = await f.answer({}, 'local-test-secret', { linkAnchors })
		expect(retry?.variables).toEqual(original?.variables)
		expect(
			tokenExpiry(later?.variables.aih_value_path_answer_1_url),
		).toMatchObject({ payload: { expiresAt: '2027-04-22T18:00:00.000Z' } })
		expect(
			tokenExpiry(retry?.variables.aih_value_path_answer_1_url),
		).toMatchObject({ payload: { expiresAt: '2027-01-22T18:00:00.000Z' } })
	})

	it('records no first issue for a blocked request, so a later sendable one anchors at its own send', async () => {
		const f = fixture()
		const linkAnchors = createMemoryValuePathLinkAnchorStore()
		const insert = vi.spyOn(linkAnchors, 'insert')
		f.setState({ ...state, lifecycle: 'suppressed' })
		const blocked = await f.answer({}, 'local-test-secret', { linkAnchors })
		expect(blocked).toMatchObject({ sendable: false, variables: {} })
		expect(insert).not.toHaveBeenCalled()
		f.setState(state)
		const later = await f.answer(
			{ dueAt: '2027-03-01T18:00:00.000Z' },
			'local-test-secret',
			{ linkAnchors },
		)
		expect(
			tokenExpiry(later?.variables.aih_value_path_answer_1_url),
		).toMatchObject({
			valid: true,
			payload: { expiresAt: '2027-06-29T18:00:00.000Z' },
		})
	})

	it('records no first issue when the personalization itself fails validation', async () => {
		const f = fixture()
		const linkAnchors = createMemoryValuePathLinkAnchorStore()
		const insert = vi.spyOn(linkAnchors, 'insert')
		const find = vi.spyOn(linkAnchors, 'find')
		const invalid = await f.answer({}, 'local-test-secret', {
			linkAnchors,
			baseUrl: '',
		})
		expect(invalid?.sendable).toBe(false)
		expect(find).not.toHaveBeenCalled()
		expect(insert).not.toHaveBeenCalled()
	})

	it('keeps answering with the dueAt + 30 day expiry when the anchor store is unavailable', async () => {
		const f = fixture()
		const broken: ValuePathLinkAnchorStore = {
			find: async () => {
				throw new Error("Table 'AI_ValuePathLinkAnchor' doesn't exist")
			},
			insert: async () => 'inserted',
		}
		const answer = await f.answer({}, 'local-test-secret', {
			linkAnchors: broken,
		})
		expect(answer).toMatchObject({ sendable: true, reasons: [] })
		expect(
			tokenExpiry(answer?.variables.aih_value_path_answer_1_url),
		).toMatchObject({
			payload: { expiresAt: '2026-10-24T18:00:00.000Z' },
		})
	})
})

describe('drovr read-only personalization', () => {
	it('returns identical signed answer URLs on a retry without using wall clock', async () => {
		const f = fixture()
		const first = await f.answer()
		const second = await f.answer()
		expect(first).toEqual(second)
		expect(first).toMatchObject({
			sendable: true,
			email: 'ada@example.com',
			firstName: 'Ada',
			reasons: [],
			flags: [],
		})
		const href = first?.variables.aih_value_path_answer_1_url
		expect(href).toContain('/ask/what-next?pt=')
		const token = new URL(href!).searchParams.get('pt')
		expect(
			verifyValuePathToken({
				token,
				secret: 'local-test-secret',
				now: new Date(dueAt),
			}),
		).toMatchObject({
			valid: true,
			payload: {
				contactId: 'contact-1',
				expiresAt: '2026-10-24T18:00:00.000Z',
			},
		})
	})

	it('blocks live opt-outs, provider flags and support review without returning variables', async () => {
		const f = fixture()
		f.events.set('contact.unsubscribed', 1)
		f.setState({ ...state, reviewSignals: ['support'], humanReview: true })
		const result = await f.answer()
		expect(result).toMatchObject({
			sendable: false,
			reasons: ['unsubscribed', 'support-intent'],
			variables: {},
		})
	})

	it.each([
		['contact.bounced', 'bounced'],
		['contact.complained', 'complained'],
	] as const)('blocks %s as %s', async (eventType, reason) => {
		const f = fixture()
		f.events.set(eventType, 1)
		expect((await f.answer())?.reasons).toContain(reason)
	})

	it('fails closed for missing state and answer-token secret', async () => {
		const f = fixture()
		f.setState(undefined)
		const result = await f.answer({}, '')
		expect(result).toMatchObject({ sendable: false, variables: {} })
		expect(result?.reasons).toContain('stale-state')
		expect(result?.reasons).toContain('path-token-secret-missing')
		expect((await f.answer({}, 'local-test-secret'))?.reasons).toContain(
			'stale-state',
		)
	})

	it('allows a provisional contact with one Kit identity and records it as a non-blocking flag', async () => {
		const f = fixture()
		f.setContact({ ...contact, isProvisional: true })
		const answer = await f.answer()
		expect(answer).toMatchObject({
			sendable: true,
			reasons: [],
			flags: ['contact-provisional'],
		})
		expect(answer?.variables.aih_value_path_answer_1_url).toContain('/ask/')
	})

	it('blocks more than one Kit identity even if the contact is provisional', async () => {
		const f = fixture()
		f.setContact({ ...contact, isProvisional: true })
		f.setIdentityConflict(true)
		expect(await f.answer()).toMatchObject({
			sendable: false,
			reasons: ['identity-conflict'],
			flags: ['contact-provisional'],
			variables: {},
		})
	})

	it('blocks a contact without a current email separately from Kit identity conflict', async () => {
		const f = fixture()
		f.setContact({ ...contact, email: null })
		expect(await f.answer()).toMatchObject({
			sendable: false,
			reasons: ['contact-email-missing'],
		})
	})

	it('returns unknown contact without a sendable answer', async () => {
		const f = fixture()
		f.setContact(undefined)
		expect(await f.answer()).toBeUndefined()
	})

	it('blocks evergreen pitch until a completed coupon provides the offer fields', async () => {
		const f = fixture()
		const pitch = {
			journeyId: 'crash-course-evergreen-offer',
			emailKey: 'pitch_open_product_origin_v1',
		}
		expect((await f.answer(pitch))?.reasons).toContain('offer-fields-missing')
		f.coupons.set('contact:contact-1:evergreen:coupon', {
			id: 'coupon-row',
			nextActionId: 'na-1',
			contactId: 'contact-1',
			provider: 'kit',
			type: 'issue-evergreen-coupon',
			status: 'completed',
			idempotencyKey: 'coupon-key',
			gates: [],
			reviewReasons: [],
			createdAt: dueAt,
			metadata: {
				couponId: 'coupon-id',
				offer: {
					productId: 'product-ma254',
					amountOffCents: 10000,
					maxUses: 1,
					exclusive: true,
					regularPriceCents: 29900,
					effectivePriceCents: 19900,
					issueAt: dueAt,
					expiresAt: '2026-09-29T09:59:59.000Z',
					timezone: 'Pacific/Kiritimati',
					timezoneSource: 'fallback',
				},
			},
		})
		const first = await f.answer(pitch)
		const second = await f.answer(pitch)
		expect(first).toEqual(second)
		expect(first).toMatchObject({
			sendable: true,
			variables: { aih_evergreen_offer_price: '$199' },
		})
	})
})

describe('double opt-in confirmation personalization', () => {
	const doi = {
		journeyId: 'double-opt-in',
		emailKey: 'ai-hero-confirm.email-0',
	}

	it('answers the email and first name for ai-hero-confirm.email-0', async () => {
		const f = fixture()
		const result = await f.answer(doi)
		expect(result).toEqual({
			email: 'ada@example.com',
			firstName: 'Ada',
			variables: {},
			sendable: true,
			reasons: [],
			flags: [],
		})
	})

	it('sends the confirmation to a new signup with no state or Kit identity yet', async () => {
		const f = fixture()
		f.setState(undefined)
		f.setContact({ ...contact, isProvisional: true, lifecycle: 'new' })
		f.setIdentityConflict(true)
		const result = await f.answer(doi)
		expect(result).toMatchObject({ sendable: true, reasons: [] })
		expect(result?.flags).toContain('contact-provisional')
	})

	it.each([true, false])(
		'resubscribeAfterUnsubscribe=%s decides whether an earlier unsubscribe holds the confirmation back',
		async (resubscribeAfterUnsubscribe) => {
			const f = fixture()
			f.events.set('contact.unsubscribed', 1)
			const result = await personalizeDrovrIntent({
				repository: f.repository,
				request: { ...request, ...doi },
				answerPages: [],
				baseUrl: 'https://www.aihero.dev',
				resubscribeAfterUnsubscribe,
			})
			expect(result).toMatchObject(
				resubscribeAfterUnsubscribe
					? { sendable: true, reasons: [] }
					: { sendable: false, reasons: ['unsubscribed'] },
			)
		},
	)

	it('defaults to the one switch, DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE', async () => {
		const f = fixture()
		f.events.set('contact.unsubscribed', 1)
		expect((await f.answer(doi))?.sendable).toBe(
			DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE,
		)
	})

	it.each([
		['contact.bounced', 'bounced'],
		['contact.complained', 'complained'],
	] as const)(
		'still holds back an address that %s',
		async (eventType, reason) => {
			const f = fixture()
			f.events.set(eventType, 1)
			expect(await f.answer(doi)).toMatchObject({
				sendable: false,
				reasons: [reason],
			})
		},
	)

	it('holds back a suppressed contact, a missing address and an unknown email key', async () => {
		const suppressed = fixture()
		suppressed.setContact({ ...contact, lifecycle: 'suppressed' })
		expect((await suppressed.answer(doi))?.reasons).toContain('suppressed')

		const noEmail = fixture()
		noEmail.setContact({ ...contact, email: null })
		expect((await noEmail.answer(doi))?.reasons).toContain(
			'contact-email-missing',
		)

		const wrongKey = fixture()
		expect(
			await wrongKey.answer({ ...doi, emailKey: 'ai-hero-confirm.email-9' }),
		).toMatchObject({ sendable: false, reasons: ['email-resource-missing'] })
	})
})

describe('drovr personalization: a fresh double opt-in lifts an unsubscribe (DOI Q5)', () => {
	const at = (iso: string) => [{ occurredAt: iso }]

	it('sends the course to a contact who unsubscribed, then confirmed a fresh double opt-in', async () => {
		const f = fixture()
		f.dated.set('contact.unsubscribed', at('2026-09-01T00:00:00.000Z'))
		f.dated.set('contact.resubscribed', at('2026-09-20T00:00:00.000Z'))
		expect(await f.answer()).toMatchObject({ sendable: true, reasons: [] })
	})

	it('blocks again after a later unsubscribe', async () => {
		const f = fixture()
		f.dated.set('contact.unsubscribed', [
			{ occurredAt: '2026-09-01T00:00:00.000Z' },
			{ occurredAt: '2026-09-22T00:00:00.000Z' },
		])
		f.dated.set('contact.resubscribed', at('2026-09-20T00:00:00.000Z'))
		expect(await f.answer()).toMatchObject({
			sendable: false,
			reasons: ['unsubscribed'],
		})
	})

	it.each([
		['contact.bounced', 'bounced'],
		['contact.complained', 'complained'],
	] as const)('never lifts %s', async (eventType, reason) => {
		const f = fixture()
		f.dated.set(eventType, at('2026-09-01T00:00:00.000Z'))
		f.dated.set('contact.resubscribed', at('2026-09-20T00:00:00.000Z'))
		expect(await f.answer()).toMatchObject({
			sendable: false,
			reasons: [reason],
		})
	})

	it('lifts a provider-reported unsubscribe on an earlier course send too', async () => {
		const f = fixture()
		f.prior.push({
			id: 'prior-1',
			status: 'completed',
			completedAt: '2026-09-01T00:00:00.000Z',
			createdAt: '2026-09-01T00:00:00.000Z',
			metadata: { providerResult: { unsubscribed: true } },
		} as never)
		expect((await f.answer())?.reasons).toContain('unsubscribed')
		f.dated.set('contact.resubscribed', at('2026-09-20T00:00:00.000Z'))
		expect(await f.answer()).toMatchObject({ sendable: true, reasons: [] })
	})
})

function oldNewsletterEvent(
	eventType: string,
	occurredAt = dueAt,
): ContactEventRecord {
	return {
		...normalizeContactEvent({
			provider: 'kit',
			externalId: 'kit-1',
			email: contact.email!,
			providerEventId: `synthetic:${eventType}:${occurredAt}`,
			eventType,
			occurredAt,
			message: 'Synthetic legacy receipt',
			privacyLevel: 'internal',
		}),
		id: `synthetic:${eventType}:${occurredAt}`,
		contactId: contact.id,
		providerIdentityId: 'identity-1',
		providerReference: OLD_NEWSLETTER_REFERENCE,
		createdAt: occurredAt,
	}
}

describe('shadow newsletter personalization requires positive old-sequence exit proof', () => {
	const newsletter = {
		journeyId: 'shadow-newsletter',
		emailKey: SHADOW_NEWSLETTER_KIT_SEQUENCES[0].messageId,
	}
	it.each(SHADOW_NEWSLETTER_KIT_SEQUENCES)(
		'serves confirmed-exit catalog message $messageId without Kit writes',
		async ({ messageId }) => {
			const f = fixture()
			f.legacyEvents.set(OLD_NEWSLETTER_EXIT_CONFIRMED, [
				oldNewsletterEvent(OLD_NEWSLETTER_EXIT_CONFIRMED),
			])
			const read = vi.spyOn(f.repository, 'findContactEventsByType')
			expect(
				await f.answer({ ...newsletter, emailKey: messageId }),
			).toMatchObject({
				email: 'ada@example.com',
				firstName: 'Ada',
				sendable: true,
				variables: {},
				reasons: [],
			})
			expect(read).toHaveBeenCalledWith(
				contact.id,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			)
		},
	)
	it('holds an unmarked existing reader with unknown legacy membership too', async () => {
		expect(await fixture().answer(newsletter)).toMatchObject({
			sendable: false,
			variables: {},
			reasons: ['old-newsletter-exit-unconfirmed'],
		})
	})
	it('holds a reader still subscribed to the old sequence', async () => {
		const f = fixture()
		f.legacyEvents.set(OLD_NEWSLETTER_SUBSCRIBED, [
			oldNewsletterEvent(OLD_NEWSLETTER_SUBSCRIBED),
		])
		expect(await f.answer(newsletter)).toMatchObject({
			sendable: false,
			reasons: ['old-newsletter-exit-unconfirmed'],
		})
	})
	it('holds when a new legacy enrollment follows the exit', async () => {
		const f = fixture()
		f.legacyEvents.set(OLD_NEWSLETTER_EXIT_CONFIRMED, [
			oldNewsletterEvent(
				OLD_NEWSLETTER_EXIT_CONFIRMED,
				'2026-09-23T18:00:00.000Z',
			),
		])
		f.legacyEvents.set(OLD_NEWSLETTER_SUBSCRIBED, [
			oldNewsletterEvent(OLD_NEWSLETTER_SUBSCRIBED),
		])
		expect(await f.answer(newsletter)).toMatchObject({
			sendable: false,
			reasons: ['old-newsletter-exit-unconfirmed'],
		})
	})
	it("accepts only the shared gate's app-owned signup absence proof", async () => {
		const f = fixture()
		const absent = oldNewsletterEvent(OLD_NEWSLETTER_ABSENT)
		f.legacyEvents.set(OLD_NEWSLETTER_ABSENT, [absent])
		expect((await f.answer(newsletter))?.sendable).toBe(false)
		f.legacyEvents.set(OLD_NEWSLETTER_ABSENT, [
			{ ...absent, payloadSummary: { ...absent.payloadSummary, source: 'drovr-owned-signup' } },
		])
		expect(await f.answer(newsletter)).toMatchObject({
			sendable: true,
			reasons: [],
		})
	})
	it('does not let an exit for another contact or sequence authorize a send', async () => {
		const f = fixture()
		const exit = oldNewsletterEvent(OLD_NEWSLETTER_EXIT_CONFIRMED)
		f.legacyEvents.set(OLD_NEWSLETTER_EXIT_CONFIRMED, [
			{ ...exit, contactId: 'other-contact' },
			{ ...exit, providerReference: 'kit:sequence:other' },
		])
		expect((await f.answer(newsletter))?.reasons).toEqual([
			'old-newsletter-exit-unconfirmed',
		])
	})
	it('lets membership read failures escape as infrastructure rather than a sendable answer or reader refusal', async () => {
		const f = fixture()
		const read = f.repository.findContactEventsByType
		vi.spyOn(f.repository, 'findContactEventsByType').mockImplementation(
			(id, type) => {
				if (type === OLD_NEWSLETTER_EXIT_CONFIRMED)
					throw new Error('storage unavailable')
				return read(id, type)
			},
		)
		await expect(f.answer(newsletter)).rejects.toMatchObject({
			reason: 'membership-or-exit-unavailable',
		})
	})
	it('still refuses an unknown newsletter email key even with confirmed exit', async () => {
		const f = fixture()
		f.legacyEvents.set(OLD_NEWSLETTER_EXIT_CONFIRMED, [
			oldNewsletterEvent(OLD_NEWSLETTER_EXIT_CONFIRMED),
		])
		expect(
			await f.answer({ ...newsletter, emailKey: 'unknown-message' }),
		).toMatchObject({ sendable: false, reasons: ['email-resource-missing'] })
	})
	it.each(['contact.unsubscribed', 'contact.bounced', 'contact.complained'])(
		'retains the %s stop after confirmed exit',
		async (eventType) => {
			const f = fixture()
			f.legacyEvents.set(OLD_NEWSLETTER_EXIT_CONFIRMED, [
				oldNewsletterEvent(OLD_NEWSLETTER_EXIT_CONFIRMED),
			])
			f.events.set(eventType, 1)
			expect(await f.answer(newsletter)).toMatchObject({
				sendable: false,
				variables: {},
			})
		},
	)
})
