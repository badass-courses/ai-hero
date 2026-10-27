type ArtworkSource = {
	fields?: { image?: { url?: string | null } | null } | null
	resources?: Array<{
		resource?: { fields?: Record<string, unknown> | null } | null
	} | null> | null
} | null

/**
 * The picture a purchase is shown with: the product's own image, else the
 * artwork of the cohort or workshop it sells. Products are usually created
 * without an image, so the resource is where the artwork actually lives.
 */
export function purchaseArtwork(product: ArtworkSource | undefined) {
	const own = product?.fields?.image?.url
	if (own) return own
	const fields = product?.resources?.[0]?.resource?.fields
	const image = fields?.image
	if (typeof image === 'string' && image) return image
	const cover = fields?.coverImage as { url?: unknown } | undefined
	return typeof cover?.url === 'string' && cover.url ? cover.url : null
}
