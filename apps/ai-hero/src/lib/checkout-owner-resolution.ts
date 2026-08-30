export const CHECKOUT_OWNER_IDENTITY_GUARD_MARKER =
	'CHECKOUT_OWNER_IDENTITY_GUARD_V1'

export type CheckoutOwnerUser = {
	id: string
	email: string
}

export type CheckoutOwnerDecision =
	| { source: 'metadata-user'; user: CheckoutOwnerUser; isNewUser: false }
	| { source: 'billing-email'; email: string }

type CheckoutOwnerInput = {
	/** metadata.userId stamped on the checkout session at creation time. */
	metadataUserId: string | null | undefined
	/** The user loaded by that id, or null when the account no longer exists. */
	metadataUser: CheckoutOwnerUser | null
	/** The billing/contact email on the Stripe customer. */
	billingEmail: string | null | undefined
}

/**
 * Decide who owns a completed checkout.
 *
 * A verified signed-in checkout stamps `metadata.userId` on the Stripe
 * checkout session at creation time. That user stays the canonical purchase
 * owner even when the billing/contact email typed at Stripe checkout differs
 * from the account email. The billing email stays on the Stripe customer
 * record only; it never creates a temporary owner account.
 *
 * The patched `@coursebuilder/core` checkout-session-completed handler mirrors
 * this contract because package code cannot import application code. Its
 * installed build carries the same guard marker so CI fails when the package
 * patch drifts away from this invariant.
 */
export function decideCheckoutOwner(
	input: CheckoutOwnerInput,
): CheckoutOwnerDecision {
	const { metadataUserId, metadataUser, billingEmail } = input

	if (metadataUserId && metadataUser) {
		if (metadataUser.id !== metadataUserId) {
			throw new Error(
				`${CHECKOUT_OWNER_IDENTITY_GUARD_MARKER}: loaded user does not match metadata.userId`,
			)
		}
		return { source: 'metadata-user', user: metadataUser, isNewUser: false }
	}

	if (!billingEmail) {
		throw new Error(
			`${CHECKOUT_OWNER_IDENTITY_GUARD_MARKER}: no owner identity available (missing billing email)`,
		)
	}

	return { source: 'billing-email', email: billingEmail }
}

type CheckoutSessionOwnerInput = {
	purchaseUserId: string | null
	purchaseEmail: string | null
	sessionUserId: string | null
	sessionUserEmail: string | null
}

/**
 * Deterministic post-checkout routing: the signed-in viewer owns the purchase
 * when their user id matches the purchase owner, regardless of what
 * billing/contact email was typed at Stripe checkout. The billing-email match
 * is kept for buyers who complete checkout signed out and then sign in with
 * that same email.
 */
export function isCheckoutSessionOwner(
	input: CheckoutSessionOwnerInput,
): boolean {
	const { purchaseUserId, purchaseEmail, sessionUserId, sessionUserEmail } =
		input

	if (sessionUserId && purchaseUserId && sessionUserId === purchaseUserId) {
		return true
	}

	if (
		sessionUserEmail &&
		purchaseEmail &&
		sessionUserEmail.toLowerCase() === purchaseEmail.toLowerCase()
	) {
		return true
	}

	return false
}
