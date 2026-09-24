import { describe, expect, it } from 'vitest'
import { verifyValuePathToken } from './path-token'
import {
	personalizeDrovrIntent,
	type DrovrPersonalizeRepository,
	type DrovrPersonalizeRequest,
} from './drovr-personalize'
import type { ContactRecord, ContactState, SideEffectIntent } from './types'

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

	it('fails closed for missing state, identity conflict and answer-token secret', async () => {
		const f = fixture()
		f.setState(undefined)
		const result = await f.answer({}, '')
		expect(result).toMatchObject({ sendable: false, variables: {} })
		expect(result?.reasons).toContain('stale-state')
		expect(result?.reasons).toContain('path-token-secret-missing')
		expect((await f.answer({}, 'local-test-secret'))?.reasons).toContain(
			'stale-state',
		)
		f.setContact({ ...contact, isProvisional: true })
		expect((await f.answer())?.reasons).toContain('identity-conflict')
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
