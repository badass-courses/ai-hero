export const CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER =
	'CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_V1'

export type CheckoutRecoveryChargeIdentity = {
	stripeChargeId: string
	userId: string
	merchantAccountId: string
	merchantProductId: string
	merchantCustomerId: string
}

type ExistingMerchantCharge = {
	id: string
	identifier: string
	userId: string
	merchantAccountId: string
	merchantProductId: string
	merchantCustomerId: string
}

export type CheckoutRecoveryChargeAdoptionDecision =
	| { action: 'create-charge' }
	| { action: 'adopt-charge'; merchantChargeId: string }
	| {
			action: 'return-purchase'
			merchantChargeId: string
			purchaseId: string
	  }

type CheckoutRecoveryChargeAdoptionInput = {
	incoming: CheckoutRecoveryChargeIdentity
} & (
	| { existingCharge: null; existingPurchaseId: null }
	| {
			existingCharge: ExistingMerchantCharge
			existingPurchaseId: string | null
	  }
)

/**
 * Decide charge adoption before any existing-Purchase return.
 *
 * The patched adapter mirrors this contract because package code cannot import
 * application code. Its installed build carries the same guard marker so CI
 * fails when the package patch drifts away from this invariant.
 */
export function decideCheckoutRecoveryChargeAdoption(
	input: CheckoutRecoveryChargeAdoptionInput,
): CheckoutRecoveryChargeAdoptionDecision {
	if (!input.existingCharge) return { action: 'create-charge' }

	const { existingCharge, existingPurchaseId, incoming } = input

	if (
		existingCharge.identifier !== incoming.stripeChargeId ||
		existingCharge.userId !== incoming.userId ||
		existingCharge.merchantAccountId !== incoming.merchantAccountId ||
		existingCharge.merchantProductId !== incoming.merchantProductId ||
		existingCharge.merchantCustomerId !== incoming.merchantCustomerId
	) {
		throw new Error(
			`${CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER}: existing merchant charge does not match checkout`,
		)
	}

	if (existingPurchaseId) {
		return {
			action: 'return-purchase',
			merchantChargeId: existingCharge.id,
			purchaseId: existingPurchaseId,
		}
	}

	return { action: 'adopt-charge', merchantChargeId: existingCharge.id }
}
