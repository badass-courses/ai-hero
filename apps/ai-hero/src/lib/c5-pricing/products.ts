// Client-safe: pricing surfaces and pages read these too.

/** The one AI Hero product the in-process engine prices: Cohort 005. */
export const C5_PRODUCT_ID = 'product-s00zs'
/** Products the authoritative-price hook prices; everything else is legacy. */
export const AUTHORITATIVE_PRODUCT_IDS: ReadonlySet<string> = new Set([
	C5_PRODUCT_ID,
])

/**
 * The checkout error reason for a buyer who already holds a region-restricted
 * ticket. The page sends them to support, which upgrades the ticket.
 */
export const REGIONAL_UPGRADE_REASON = 'regional-upgrade'
export const REGIONAL_UPGRADE_PATH = `/subscribe/error?reason=${REGIONAL_UPGRADE_REASON}`
