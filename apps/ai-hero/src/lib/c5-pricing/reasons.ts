// Client-safe: the pricing surfaces read these too.

/**
 * Reason codes this app adds to the engine's own. They tell the pricing
 * surfaces why a price is not a charge.
 */
export const APP_REASONS = {
	/** Nobody is signed in: the price is the new-buyer upper bound. */
	identityRequired: 'identity-required',
	/** Display could not read the buyer's binding quotes. */
	quotesUnavailable: 'quotes-unavailable',
	/** Checkout could not read the buyer's binding quotes fresh. */
	quotesUnavailableAtCheckout: 'quotes-unavailable-at-checkout',
	policyUnavailable: 'policy-unavailable',
	factsUnavailable: 'facts-unavailable',
	priceMismatch: 'merchant-price-mismatch',
	killSwitch: 'kill-switch',
	/**
	 * The buyer already holds a region-restricted purchase of this product.
	 * There is no upgrade path; unrestricted access goes through support.
	 */
	restrictedHolder: 'restricted-holder',
} as const
