import type { PricingPolicyData } from '@ai-hero/front-desk-support/pricing'
import type { GiftCode } from './gift-slots'
import { C5_PRODUCT_ID } from './products'
import { AUTHORITATIVE_CLOSE_BUFFER_MS } from '@coursebuilder/commerce/authoritative-price'

/** Only server cookie verification AND a fresh coupon/ledger read may supply this. */
export type VerifiedOpeningGift = {
	readonly verified: boolean
	readonly productId: string
	readonly code: GiftCode
}
export type BuyerOpeningInput = {
	readonly switchEnabled: boolean
	readonly overrideDisabled: boolean
	readonly now: number
	readonly window: {
		readonly opensAt: number | null
		readonly checkoutStopsAt: number
		readonly closesAt: number
	} | null
	readonly gift: VerifiedOpeningGift | null
}

/** The switch-off/before-open exception never changes the ordinary pricing rules. */
export function c5BuyerOpening(
	input: BuyerOpeningInput,
): 'closed' | 'standard' | 'gift' {
	const { window, now, gift } = input
	if (
		input.overrideDisabled ||
		!window ||
		!Number.isFinite(now) ||
		(window.opensAt !== null && !Number.isFinite(window.opensAt)) ||
		!Number.isFinite(window.checkoutStopsAt) ||
		!Number.isFinite(window.closesAt) ||
		now >= window.checkoutStopsAt ||
		now >= window.closesAt
	)
		return 'closed'
	if (input.switchEnabled && (window.opensAt === null || now >= window.opensAt))
		return 'standard'
	if (
		!gift?.verified ||
		gift.productId !== C5_PRODUCT_ID ||
		gift.code.usesTaken >= gift.code.maxUses ||
		!Number.isFinite(Date.parse(gift.code.expiresAt)) ||
		Math.min(Date.parse(gift.code.expiresAt), window.closesAt) - now <
			AUTHORITATIVE_CLOSE_BUFFER_MS
	)
		return 'closed'
	return 'gift'
}

export function policyOpeningWindow(
	policy: PricingPolicyData | null,
): BuyerOpeningInput['window'] {
	if (
		!policy?.enabled ||
		!('value' in policy.opensAt) ||
		!('value' in policy.checkoutStopsAt) ||
		!('value' in policy.closesAt)
	)
		return null
	return {
		opensAt:
			policy.opensAt.value === null ? null : Date.parse(policy.opensAt.value),
		checkoutStopsAt: Date.parse(policy.checkoutStopsAt.value),
		closesAt: Date.parse(policy.closesAt.value),
	}
}
