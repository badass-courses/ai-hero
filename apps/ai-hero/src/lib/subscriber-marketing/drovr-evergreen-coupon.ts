import { Effect } from 'effect'
import { z } from 'zod'

import type { CaptureMarketingRepository } from './capture-contact-event'
import {
	EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
	EVERGREEN_OFFER_CURRENCY,
	EVERGREEN_OFFER_MAX_USES,
	EVERGREEN_OFFER_PRODUCT_ID,
	type IssueCouponIntent,
} from './evergreen-offer-journey/domain'
import type {
	CouponAuthority,
	EffectApplicationError,
} from './evergreen-offer-journey/ports'
import {
	couponIntentKey,
	parseContactId,
	parseIanaTimeZone,
	parseIsoInstant,
	parseJourneyId,
} from './evergreen-offer-journey/primitives'
import type { DeadlineTimeZoneEvidence } from './course-sequence-exhaustion'
import { dispatchDrovrShadowFactSafely } from './drovr-shadow-dispatch'
import type { SideEffectIntent } from './types'

/**
 * The coupon arm for drovr's evergreen pitch. drovr decides *when* (the
 * Thursday wake, v3 carries the window and time zone on the intent); ai-hero
 * owns the coupon: the pilot's `CouponAuthority` writes one contact-owned,
 * exclusive, product-restricted coupon under a semantic id, and this arm
 * publishes the offer values to the contact's Kit fields so the pitch emails
 * render them. The coupon row is the only expiry authority (settled contract).
 */

export const ISSUE_EVERGREEN_COUPON_INTENT_TYPE =
	'issue-evergreen-coupon' as const

export const EVERGREEN_OFFER_FIELD_KEYS = {
	deadlineDisplay: 'aih_evergreen_deadline_display',
	discountAmount: 'aih_evergreen_discount_amount',
	offerPrice: 'aih_evergreen_offer_price',
	offerUrl: 'aih_evergreen_offer_url',
	regularPrice: 'aih_evergreen_regular_price',
} as const

const isoInstant = z
	.string()
	.refine((value) => Number.isFinite(Date.parse(value)), 'not an ISO instant')

/** What drovr's v3 evergreen journey puts on a coupon.issue intent. */
export const CouponIssuePayload = z.object({
	productId: z.literal(EVERGREEN_OFFER_PRODUCT_ID),
	amountOffCents: z.literal(EVERGREEN_OFFER_AMOUNT_OFF_CENTS),
	maxUses: z.literal(EVERGREEN_OFFER_MAX_USES),
	exclusive: z.literal(true),
	regularPriceCents: z.number().int().positive(),
	effectivePriceCents: z.number().int().positive(),
	issueAt: isoInstant,
	expiresAt: isoInstant,
	timezone: z.string().min(1),
	timezoneSource: z.string().min(1),
})
export type CouponIssuePayload = z.infer<typeof CouponIssuePayload>

/** One evergreen journey identity per drovr contact, in the pilot's id space. */
export function evergreenJourneyIdForContact(contactId: string) {
	const parsed = parseJourneyId(`evergreen-offer:drovr:${contactId}`)
	if (!parsed.ok)
		throw new Error(`invalid evergreen journey id for ${contactId}`)
	return parsed.value
}

/**
 * drovr pins the zone when the journey starts. Its `fallback` source does
 * not promise the ai-hero course-entry default (America/Los_Angeles): a
 * previously pinned valid zone may also carry that source. Validate this
 * executor boundary against Intl rather than the course-entry fallback rule.
 */
export function deadlineEvidenceFromPayload(
	payload: CouponIssuePayload,
): DeadlineTimeZoneEvidence {
	const zone = parseIanaTimeZone(payload.timezone)
	if (!zone.ok)
		throw new Error(`invalid deadline time zone ${payload.timezone}`)
	const capturedAt = parseIsoInstant(payload.issueAt)
	if (!capturedAt.ok)
		throw new Error(`invalid coupon issue instant ${payload.issueAt}`)
	return payload.timezoneSource === 'vercel-header'
		? {
				type: 'BrowserEntryHeader',
				headerName: 'x-vercel-ip-timezone',
				timeZone: zone.value,
				capturedAt: capturedAt.value,
			}
		: {
				type: 'ExplicitFallback',
				reason: 'header-missing',
				timeZone: zone.value,
				capturedAt: capturedAt.value,
			}
}

export function issueIntentFor(
	contactId: string,
	payload: CouponIssuePayload,
): IssueCouponIntent {
	const journeyId = evergreenJourneyIdForContact(contactId)
	const contact = parseContactId(contactId)
	if (!contact.ok) throw new Error(`invalid contact id ${contactId}`)
	return {
		type: 'IssueCoupon',
		idempotencyKey: couponIntentKey(journeyId),
		journeyId,
		contactId: contact.value,
		// SAFETY: CouponIssuePayload refined both as parseable ISO instants.
		issueAt: payload.issueAt as IssueCouponIntent['issueAt'],
		expiresAt: payload.expiresAt as IssueCouponIntent['expiresAt'],
		terms: {
			productId: EVERGREEN_OFFER_PRODUCT_ID,
			currency: EVERGREEN_OFFER_CURRENCY,
			amountOffCents: EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
			maxUses: EVERGREEN_OFFER_MAX_USES,
			exclusive: true,
		},
		deadlineTimeZone: deadlineEvidenceFromPayload(payload),
	}
}

export const money = (cents: number): string =>
	`$${Math.round(cents / 100).toLocaleString('en-US')}`

export function deadlineDisplay(expiresAt: string, timeZone: string): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone,
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short',
	}).format(new Date(expiresAt))
}

/**
 * The claim entry the pitch links to. The claim route (E1b-3) reads `claim`,
 * verifies the logged-in user resolves to the owning contact, binds the
 * coupon, and hands to checkout. Never a reusable public code.
 */
export function evergreenOfferUrl(origin: string, couponId: string): string {
	const url = new URL('/workshops/ai-coding-crash-course', origin)
	url.searchParams.set('claim', couponId)
	return url.toString()
}

export function offerFieldsFor(input: {
	couponId: string
	payload: CouponIssuePayload
	origin: string
}): Record<string, string> {
	return {
		[EVERGREEN_OFFER_FIELD_KEYS.offerUrl]: evergreenOfferUrl(
			input.origin,
			input.couponId,
		),
		[EVERGREEN_OFFER_FIELD_KEYS.offerPrice]: money(
			input.payload.effectivePriceCents,
		),
		[EVERGREEN_OFFER_FIELD_KEYS.regularPrice]: money(
			input.payload.regularPriceCents,
		),
		[EVERGREEN_OFFER_FIELD_KEYS.discountAmount]: money(
			input.payload.amountOffCents,
		),
		[EVERGREEN_OFFER_FIELD_KEYS.deadlineDisplay]: deadlineDisplay(
			input.payload.expiresAt,
			input.payload.timezone,
		),
	}
}

export type CouponIssuerRepository = Pick<
	CaptureMarketingRepository,
	'findContactById'
> &
	Required<
		Pick<
			CaptureMarketingRepository,
			'findPendingSideEffectIntentsByType' | 'updateSideEffectIntent'
		>
	>

export type CouponIssueResult =
	| { status: 'completed'; intentId: string; couponId: string }
	| { status: 'retry'; intentId: string; attempts: number; error: string }
	| { status: 'failed'; intentId: string; error: string }

export const EVERGREEN_COUPON_MAX_ATTEMPTS = 6

const numberField = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0
const stringField = (value: unknown): string | undefined =>
	typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * Drain pending coupon rows: issue through the authority (idempotent on the
 * semantic key, so a retry reads the same coupon back), publish the offer
 * fields to Kit, complete the row, and dispatch `coupon.issued` to drovr.
 *
 * Authority verdicts map straight onto the row: a permanent refusal is
 * terminal; transient unavailability retries; an ambiguous outcome is
 * terminal for a human because the transaction may or may not have
 * committed and only a readback can say. A Kit failure after a successful
 * issue retries: the next run reads the same coupon back and rewrites the
 * same field values.
 */
export async function executePendingEvergreenCoupons(args: {
	repository: CouponIssuerRepository
	authority: Pick<CouponAuthority, 'issue'>
	writeFields: (input: {
		subscriberId: string
		email: string
		fields: Record<string, string>
	}) => Promise<void>
	origin: string
	limit: number
	now?: () => string
	dispatch?: (intent: SideEffectIntent) => void
}): Promise<CouponIssueResult[]> {
	const now = args.now ?? (() => new Date().toISOString())
	const dispatch =
		args.dispatch ??
		((intent: SideEffectIntent) =>
			dispatchDrovrShadowFactSafely({
				kind: 'side-effect-intent-completed',
				intent,
			}))
	const rows = await args.repository.findPendingSideEffectIntentsByType(
		ISSUE_EVERGREEN_COUPON_INTENT_TYPE,
		args.limit,
	)
	const results: CouponIssueResult[] = []
	for (const row of rows) {
		results.push(await issueOne({ row, args, now: now(), dispatch }))
	}
	return results
}

async function issueOne(input: {
	row: SideEffectIntent
	args: Pick<
		Parameters<typeof executePendingEvergreenCoupons>[0],
		'repository' | 'authority' | 'writeFields' | 'origin'
	>
	now: string
	dispatch: (intent: SideEffectIntent) => void
}): Promise<CouponIssueResult> {
	const { row, args, now, dispatch } = input
	const fail = async (reason: string, message = reason) => {
		await args.repository.updateSideEffectIntent(row.id, {
			status: 'failed',
			completedAt: null,
			gates: row.gates,
			reviewReasons: [...row.reviewReasons, reason],
			metadata: { ...row.metadata, lastError: message },
		})
		return { status: 'failed', intentId: row.id, error: message } as const
	}
	const payload = CouponIssuePayload.safeParse(row.metadata.offer)
	if (!payload.success) return await fail('coupon-offer-payload-invalid')
	const subscriberId = stringField(row.metadata.kitSubscriberId)
	if (!subscriberId) return await fail('kit-subscriber-missing')
	const contact = await args.repository.findContactById(row.contactId)
	if (!contact?.email) return await fail('contact-email-missing')
	const attempts = numberField(row.metadata.attempts) + 1

	// Intent construction validates the pinned zone outside the Effect; a bad
	// row fails on its own instead of aborting the drain for every row after it.
	let intent: IssueCouponIntent
	try {
		intent = issueIntentFor(row.contactId, payload.data)
	} catch (error) {
		return await fail(
			'coupon-intent-invalid',
			error instanceof Error ? error.message : String(error),
		)
	}
	const outcome = await Effect.runPromise(
		Effect.either(args.authority.issue(intent)),
	)
	if (outcome._tag === 'Left') {
		return await settleAuthorityFailure(
			row,
			attempts,
			outcome.left,
			args.repository,
		)
	}
	const { coupon } = outcome.right
	try {
		await args.writeFields({
			subscriberId,
			email: contact.email,
			fields: offerFieldsFor({
				couponId: coupon.couponId,
				payload: payload.data,
				origin: args.origin,
			}),
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (attempts >= EVERGREEN_COUPON_MAX_ATTEMPTS) {
			return await fail('evergreen-coupon-fields-exhausted', message)
		}
		await args.repository.updateSideEffectIntent(row.id, {
			status: 'pending',
			completedAt: null,
			gates: row.gates,
			reviewReasons: row.reviewReasons,
			metadata: {
				...row.metadata,
				attempts,
				couponId: coupon.couponId,
				lastError: message,
			},
		})
		return { status: 'retry', intentId: row.id, attempts, error: message }
	}
	const completed = await args.repository.updateSideEffectIntent(row.id, {
		status: 'completed',
		completedAt: now,
		gates: row.gates,
		reviewReasons: [],
		metadata: {
			...row.metadata,
			attempts,
			completedAt: now,
			couponId: coupon.couponId,
			expiresAt: coupon.expiresAt,
			issuedAt: coupon.issuedAt,
		},
	})
	dispatch(completed)
	return { status: 'completed', intentId: row.id, couponId: coupon.couponId }
}

async function settleAuthorityFailure(
	row: SideEffectIntent,
	attempts: number,
	failure: EffectApplicationError,
	repository: CouponIssuerRepository,
): Promise<CouponIssueResult> {
	const message = `${failure.type}:${failure.reason}`
	const terminal =
		failure.type !== 'EffectTransientUnavailable' ||
		attempts >= EVERGREEN_COUPON_MAX_ATTEMPTS
	await repository.updateSideEffectIntent(row.id, {
		status: terminal ? 'failed' : 'pending',
		completedAt: null,
		gates: row.gates,
		reviewReasons: terminal
			? [...row.reviewReasons, `coupon-${failure.type}`]
			: row.reviewReasons,
		metadata: { ...row.metadata, attempts, lastError: message },
	})
	return terminal
		? { status: 'failed', intentId: row.id, error: message }
		: { status: 'retry', intentId: row.id, attempts, error: message }
}
