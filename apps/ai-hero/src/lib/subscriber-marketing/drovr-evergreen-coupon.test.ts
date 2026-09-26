import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
	deadlineDisplay,
	evergreenOfferUrl,
	executePendingEvergreenCoupons,
	issueIntentFor,
	money,
	offerFieldsFor,
	type CouponIssuePayload,
	type CouponIssuerRepository,
} from './drovr-evergreen-coupon'
import type { EffectApplicationError } from './evergreen-offer-journey/ports'
import type { ContactRecord, SideEffectIntent } from './types'

const now = '2026-09-10T16:00:05.000Z'

const payload: CouponIssuePayload = {
	productId: 'product-ma254',
	amountOffCents: 10_000,
	maxUses: 1,
	exclusive: true,
	regularPriceCents: 29_900,
	effectivePriceCents: 19_900,
	issueAt: '2026-09-10T16:00:00.000Z',
	expiresAt: '2026-09-15T06:59:59.000Z',
	timezone: 'America/Los_Angeles',
	timezoneSource: 'vercel-header',
}

class FakeRepository implements CouponIssuerRepository {
	contacts = new Map<string, ContactRecord>()
	intents = new Map<string, SideEffectIntent>()
	findContactById(id: string) {
		return this.contacts.get(id)
	}
	findPendingSideEffectIntentsByType(
		type: SideEffectIntent['type'],
		limit: number,
	) {
		return Array.from(this.intents.values())
			.filter((row) => row.type === type && row.status === 'pending')
			.slice(0, limit)
	}
	updateSideEffectIntent(
		id: string,
		patch: Pick<
			SideEffectIntent,
			'status' | 'gates' | 'reviewReasons' | 'metadata'
		> &
			Partial<Pick<SideEffectIntent, 'completedAt'>>,
	) {
		const row = this.intents.get(id)
		if (!row) throw new Error(`no row ${id}`)
		const next = { ...row, ...patch }
		this.intents.set(id, next)
		return next
	}
}

const contact = (): ContactRecord => ({
	id: 'contact-1',
	email: 'learner@example.com',
	name: 'Learner',
	lifecycle: 'nurture-ready',
	isProvisional: false,
	createdAt: now,
	updatedAt: now,
})

const row = (overrides: Partial<SideEffectIntent> = {}): SideEffectIntent => ({
	id: 'row-1',
	nextActionId: 'drovr:abc',
	contactId: 'contact-1',
	provider: 'kit',
	type: 'issue-evergreen-coupon',
	status: 'pending',
	idempotencyKey: 'contact:contact-1:evergreen:coupon',
	gates: [],
	reviewReasons: [],
	metadata: {
		source: 'drovr',
		kitSubscriberId: '4298556847',
		offer: payload,
		drovr: {
			tenantId: 'org-aihero',
			journeyId: 'crash-course-evergreen-offer',
			intentKey: 'k-coupon',
		},
	},
	createdAt: '2026-09-10T16:00:01.000Z',
	...overrides,
})

const issued = {
	coupon: {
		couponId: 'eoj-coupon:abc',
		contactId: 'contact-1',
		issuedAt: payload.issueAt,
		expiresAt: payload.expiresAt,
		terms: {
			productId: 'product-ma254',
			currency: 'USD',
			amountOffCents: 10_000,
			maxUses: 1,
			exclusive: true,
		},
		deadlineTimeZone: {
			type: 'BrowserEntryHeader',
			headerName: 'x-vercel-ip-timezone',
			timeZone: 'America/Los_Angeles',
			capturedAt: payload.issueAt,
		},
		binding: { type: 'AwaitingVerifiedUser' },
	},
	providerReceiptId: 'commerce-coupon:eoj-coupon:abc',
} as unknown as Parameters<
	Parameters<typeof executePendingEvergreenCoupons>[0]['authority']['issue']
>[0] extends never
	? never
	: import('./evergreen-offer-journey/ports').CouponIssueReceipt

describe('issue intent and offer fields', () => {
	it('builds the pilot-shaped IssueCoupon intent from drovr payload', () => {
		const intent = issueIntentFor('contact-1', payload)
		expect(intent).toMatchObject({
			type: 'IssueCoupon',
			journeyId: 'evergreen-offer:drovr:contact-1',
			idempotencyKey: 'evergreen-offer:drovr:contact-1:coupon.issue',
			contactId: 'contact-1',
			issueAt: payload.issueAt,
			expiresAt: payload.expiresAt,
			terms: {
				productId: 'product-ma254',
				currency: 'USD',
				amountOffCents: 10_000,
			},
			deadlineTimeZone: {
				type: 'BrowserEntryHeader',
				timeZone: 'America/Los_Angeles',
			},
		})
		expect(
			issueIntentFor('contact-1', { ...payload, timezoneSource: 'fallback' })
				.deadlineTimeZone.type,
		).toBe('ExplicitFallback')
	})

	it('accepts a drovr-pinned UTC+14 zone even when its source is fallback', () => {
		const acceptedByIntl = 'Pacific/Kiritimati'
		expect(() => new Intl.DateTimeFormat('en-US', { timeZone: acceptedByIntl })).not.toThrow()
		expect(
			issueIntentFor('contact-1', {
				...payload,
				timezone: acceptedByIntl,
				timezoneSource: 'fallback',
			}).deadlineTimeZone,
		).toMatchObject({
			type: 'ExplicitFallback',
			timeZone: acceptedByIntl,
			capturedAt: payload.issueAt,
		})
		// The browser-header source has the same accepted-zone contract.
		expect(
			issueIntentFor('contact-1', {
				...payload,
				timezone: acceptedByIntl,
			}).deadlineTimeZone,
		).toMatchObject({ type: 'BrowserEntryHeader', timeZone: acceptedByIntl })
		expect(() =>
			issueIntentFor('contact-1', { ...payload, timezone: 'Not/AZone' }),
		).toThrow('invalid deadline time zone Not/AZone')
	})

	it('renders the five Kit field values the pitch copy reads', () => {
		expect(money(19_900)).toBe('$199')
		expect(money(29_900)).toBe('$299')
		expect(deadlineDisplay(payload.expiresAt, 'America/Los_Angeles')).toBe(
			'Monday, September 14, 2026 at 11:59 PM PDT',
		)
		expect(evergreenOfferUrl('https://www.aihero.dev', 'eoj-coupon:abc')).toBe(
			'https://www.aihero.dev/workshops/ai-coding-crash-course?coupon=eoj-coupon%3Aabc',
		)
		expect(
			offerFieldsFor({
				couponId: 'c1',
				payload,
				origin: 'https://www.aihero.dev',
			}),
		).toEqual({
			aih_evergreen_offer_url:
				'https://www.aihero.dev/workshops/ai-coding-crash-course?coupon=c1',
			aih_evergreen_offer_price: '$199',
			aih_evergreen_regular_price: '$299',
			aih_evergreen_discount_amount: '$100',
			aih_evergreen_deadline_display:
				'Monday, September 14, 2026 at 11:59 PM PDT',
		})
	})
})

describe('executePendingEvergreenCoupons', () => {
	const run = async (input: {
		issue: () => Effect.Effect<typeof issued, EffectApplicationError>
		writeFields?: () => Promise<void>
		attempts?: number
	}) => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.intents.set(
			'row-1',
			row(
				input.attempts === undefined
					? {}
					: { metadata: { ...row().metadata, attempts: input.attempts } },
			),
		)
		const written: unknown[] = []
		const dispatched: SideEffectIntent[] = []
		const results = await executePendingEvergreenCoupons({
			repository,
			authority: { issue: input.issue },
			writeFields:
				input.writeFields ??
				(async (fields) => {
					written.push(fields)
				}),
			origin: 'https://www.aihero.dev',
			limit: 10,
			now: () => now,
			dispatch: (intent) => dispatched.push(intent),
		})
		return {
			results,
			row: repository.intents.get('row-1')!,
			written,
			dispatched,
		}
	}

	it('issues, writes the offer fields to the Kit subscriber, completes, and dispatches', async () => {
		const out = await run({ issue: () => Effect.succeed(issued) })
		expect(out.results).toEqual([
			{
				status: 'completed',
				intentId: 'row-1',
				contactId: 'contact-1',
				couponId: 'eoj-coupon:abc',
			},
		])
		expect(out.written).toEqual([
			{
				subscriberId: '4298556847',
				email: 'learner@example.com',
				fields: expect.objectContaining({
					aih_evergreen_offer_price: '$199',
					aih_evergreen_offer_url:
						'https://www.aihero.dev/workshops/ai-coding-crash-course?coupon=eoj-coupon%3Aabc',
				}),
			},
		])
		expect(out.row).toMatchObject({
			status: 'completed',
			completedAt: now,
			metadata: { couponId: 'eoj-coupon:abc', expiresAt: payload.expiresAt },
		})
		expect(out.dispatched.map((d) => d.status)).toEqual(['completed'])
	})

	it('goes terminal on a permanent refusal and on an ambiguous outcome', async () => {
		for (const failure of [
			{ type: 'EffectPermanentRefusal', reason: 'merchant-coupon-conflict' },
			{ type: 'EffectAmbiguous', reason: 'commerce-transaction-unresolved' },
		] as const) {
			const out = await run({ issue: () => Effect.fail(failure) })
			expect(out.results[0]).toMatchObject({ status: 'failed' })
			expect(out.row).toMatchObject({
				status: 'failed',
				reviewReasons: [`coupon-${failure.type}`],
				metadata: { failedAt: now },
			})
			expect(out.dispatched).toEqual([out.row])
		}
	})

	it('retries a transient authority failure and a Kit field write failure', async () => {
		const transient = await run({
			issue: () =>
				Effect.fail({
					type: 'EffectTransientUnavailable',
					reason: 'clock-unavailable',
				}),
		})
		expect(transient.results[0]).toMatchObject({ status: 'retry', attempts: 1 })
		expect(transient.row.status).toBe('pending')
		expect(transient.dispatched).toEqual([])

		const kitDown = await run({
			issue: () => Effect.succeed(issued),
			writeFields: async () => {
				throw new Error('kit v4 answered 503')
			},
		})
		expect(kitDown.results[0]).toMatchObject({ status: 'retry', attempts: 1 })
		expect(kitDown.row).toMatchObject({
			status: 'pending',
			metadata: {
				couponId: 'eoj-coupon:abc',
				lastError: 'kit v4 answered 503',
			},
		})
		expect(kitDown.dispatched).toEqual([])
	})

	it('fails a row without a Kit subscriber or with an unreadable offer', async () => {
		const repository = new FakeRepository()
		repository.intents.set(
			'row-1',
			row({ metadata: { ...row().metadata, kitSubscriberId: undefined } }),
		)
		repository.intents.set(
			'row-2',
			row({
				id: 'row-2',
				idempotencyKey: 'k2',
				metadata: { ...row().metadata, offer: { nope: true } },
			}),
		)
		const results = await executePendingEvergreenCoupons({
			repository,
			authority: { issue: () => Effect.succeed(issued) },
			writeFields: async () => {},
			origin: 'https://www.aihero.dev',
			limit: 10,
			dispatch: () => {},
		})
		expect(results.map((r) => r.status)).toEqual(['failed', 'failed'])
		expect(repository.intents.get('row-1')?.reviewReasons).toEqual([
			'kit-subscriber-missing',
		])
		expect(repository.intents.get('row-2')?.reviewReasons).toEqual([
			'coupon-offer-payload-invalid',
		])
	})

	it('writes the Kit fields with the contact email and fails a row without one', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.contacts.set('contact-2', {
			...contact(),
			id: 'contact-2',
			email: '',
		})
		repository.intents.set('row-1', row())
		repository.intents.set(
			'row-2',
			row({ id: 'row-2', idempotencyKey: 'k2', contactId: 'contact-2' }),
		)
		const written: { subscriberId: string; email: string }[] = []
		const results = await executePendingEvergreenCoupons({
			repository,
			authority: { issue: () => Effect.succeed(issued) },
			writeFields: async ({ subscriberId, email }) => {
				written.push({ subscriberId, email })
			},
			origin: 'https://www.aihero.dev',
			limit: 10,
			dispatch: () => {},
		})
		expect(results.map((r) => r.status)).toEqual(['completed', 'failed'])
		expect(written).toEqual([
			{ subscriberId: '4298556847', email: 'learner@example.com' },
		])
		expect(repository.intents.get('row-2')?.reviewReasons).toEqual([
			'contact-email-missing',
		])
	})

	it('fails a row whose pinned zone is invalid without aborting the drain', async () => {
		const repository = new FakeRepository()
		repository.contacts.set('contact-1', contact())
		repository.intents.set(
			'row-1',
			row({
				metadata: {
					...row().metadata,
					offer: { ...payload, timezone: 'Not/AZone' },
				},
			}),
		)
		repository.intents.set('row-2', row({ id: 'row-2', idempotencyKey: 'k2' }))
		let issues = 0
		const results = await executePendingEvergreenCoupons({
			repository,
			authority: {
				issue: () => {
					issues += 1
					return Effect.succeed(issued)
				},
			},
			writeFields: async () => {},
			origin: 'https://www.aihero.dev',
			limit: 10,
			dispatch: () => {},
		})
		expect(results.map((r) => r.status)).toEqual(['failed', 'completed'])
		expect(issues).toBe(1)
		expect(repository.intents.get('row-1')?.status).toBe('failed')
		expect(repository.intents.get('row-1')?.reviewReasons).toEqual([
			'coupon-intent-invalid',
		])
	})
})
