import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import { products } from '@/db/schema'
import { eq } from 'drizzle-orm'

/**
 * Tag shared with every product write. `revalidateProducts()` in
 * `@/lib/product-cache` invalidates it on create, update (slug included),
 * archive, and resource attach or detach, so the map never needs a write
 * path of its own.
 */
export const PRODUCT_SLUG_MAP_TAGS = ['products']

/** Backstop for a write that somehow skips the tag. */
export const PRODUCT_SLUG_MAP_REVALIDATE_SECONDS = 300

export type ProductSlugEntry = { id: string; slug: string | undefined }

/**
 * Active products as `{ id, slug }`, nothing else. Reads `fields` only to
 * pull the slug out, so the cached value stays two strings per product
 * however large a product's fields grow.
 */
export async function loadActiveProductSlugEntries(): Promise<
	ProductSlugEntry[]
> {
	const rows = await db.query.products.findMany({
		columns: { id: true, fields: true },
		where: eq(products.status, 1),
	})
	return rows.map((row) => ({
		id: row.id,
		slug: (row.fields as { slug?: string } | null)?.slug,
	}))
}

/**
 * Shared across visitors: it holds product identity only, never purchases.
 * `HasPurchased` still checks the visitor's own purchases on every render.
 */
export const getCachedActiveProductSlugEntries = unstable_cache(
	loadActiveProductSlugEntries,
	['active-product-slug-map-v1'],
	{
		revalidate: PRODUCT_SLUG_MAP_REVALIDATE_SECONDS,
		tags: PRODUCT_SLUG_MAP_TAGS,
	},
)

/**
 * Slug → id, built the way the cohort page always built it, minus products
 * with no slug: `HasPurchased` only looks a slug up when it has one. The
 * cache holds the entries, not the Map, because `unstable_cache` stores JSON.
 */
export function toProductSlugMap(
	entries: ProductSlugEntry[],
): Map<string, string> {
	const map = new Map<string, string>()
	for (const { slug, id } of entries) {
		if (slug !== undefined) map.set(slug, id)
	}
	return map
}

export async function getActiveProductSlugMap() {
	return toProductSlugMap(await getCachedActiveProductSlugEntries())
}
