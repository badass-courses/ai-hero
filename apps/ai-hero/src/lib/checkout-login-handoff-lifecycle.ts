export const checkoutLoginHandoffTransitions = {
	issued: ['consuming', 'expired'],
	consuming: ['completed', 'failed_retryable'],
	failed_retryable: ['consuming', 'expired'],
	completed: [],
	expired: [],
} as const

export type CheckoutLoginHandoffState =
	keyof typeof checkoutLoginHandoffTransitions

export function canTransitionCheckoutLoginHandoff(
	from: CheckoutLoginHandoffState,
	to: CheckoutLoginHandoffState,
) {
	return (checkoutLoginHandoffTransitions[from] as readonly string[]).includes(
		to,
	)
}

export function checkoutLoginHandoffSourcesFor(
	to: CheckoutLoginHandoffState,
): CheckoutLoginHandoffState[] {
	return (Object.keys(
		checkoutLoginHandoffTransitions,
	) as CheckoutLoginHandoffState[]).filter((from) =>
		canTransitionCheckoutLoginHandoff(from, to),
	)
}
