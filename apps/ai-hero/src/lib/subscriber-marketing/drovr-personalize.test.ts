import { describe, expect, it } from 'vitest'
import { verifyValuePathToken } from './path-token'
import {
	personalizeDrovrIntent,
	type DrovrPersonalizeRepository,
	type DrovrPersonalizeRequest,
} from './drovr-personalize'
import type { ContactRecord, ContactState, SideEffectIntent } from './types'
import { DOUBLE_OPT_IN_RESUBSCRIBE_AFTER_UNSUBSCRIBE } from './drovr-list-subscribe'

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
	const prior: SideEffectIntent[] = []
	const coupons = new Map<string, SideEffectIntent>()
	const repository: DrovrPersonalizeRepository = {
		findContactById: () => currentContact,
		findCurrentContactState: () => currentState,
		findContactEventsByType: (_, type) => Array(events.get(type) ?? 0).fill({}),
		findValuePathEmailSideEffectIntentsByContact: () => prior,
		findSideEffectIntentByIdempotencyKey: (key) => coupons.get(key),
	}
	return {
		repository,
		events,
		prior,
		coupons,
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
		) =>
			personalizeDrovrIntent({
				repository,
				request: { ...request, ...overrides },
				answerPages: [page],
				pathTokenSecret: secret,
				baseUrl: 'https://www.aihero.dev',
				kitSubscriberId: 'kit-1',
				identityConflict,
			}),
	}
}

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
