// Client-safe: the pricing surfaces read these too.

/**
 * Reason codes this app adds to the engine's own. They tell the pricing
 * surfaces why a price is not a charge.
 */
export const APP_REASONS = {
	/** The engine's formula candidate uses an available Crash Course credit. */
	formulaUsesCredit: 'formula-uses-crash-course-credit',
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
	/** Early gifts must not sell access the buyer already owns. */
	alreadyOwned: 'already-owned',
	/**
	 * The buyer already holds a region-restricted purchase of this product.
	 * There is no upgrade path; unrestricted access goes through support.
	 */
	restrictedHolder: 'restricted-holder',
	/**
	 * The regional price is bounded only by an unresolved Crash Course credit.
	 * Set only on front-desk's exact signature (`isPppCreditBound`); this one
	 * bounded case may buy, and checkout charges the bound.
	 */
	pppCreditBound: 'ppp-credit-unresolved-bound',
} as const
