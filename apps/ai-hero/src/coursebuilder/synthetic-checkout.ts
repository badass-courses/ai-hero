import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'

export const SYNTHETIC_CHECKOUT_REFUSED = 'synthetic-checkout-refused'

/**
 * Synthetic test principals (#36T) never create a Stripe customer or checkout
 * session until a checkout-under-test contract exists (T8). Returns the 403
 * for a checkout request by one; undefined lets the request through.
 */
export function syntheticCheckoutRefusal(
	pathname: string,
	userId: string | null | undefined,
): Response | undefined {
	if (!pathname.includes('/checkout/') || !isSyntheticPrincipalId(userId)) {
		return undefined
	}
	return Response.json(
		{
			type: `urn:aihero:problem:${SYNTHETIC_CHECKOUT_REFUSED}`,
			title: 'Checkout is not available to test principals',
			status: 403,
			detail: 'A synthetic test principal cannot start a Stripe checkout.',
			hint: 'Assert the checkout request at the network layer and abort it.',
		},
		{ status: 403, headers: { 'content-type': 'application/problem+json' } },
	)
}
