import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'

import { PromoBarContent } from './promo-bar-content'
import { FEATURED_PROMO, isPromoActive, type Promo } from './promo-config'
import { TimedPromoBarSwitch } from './timed-promo-bar-switch'

/**
 * The newest published + public post, and nothing else about it.
 *
 * This used to call `getCachedAllPosts()` and `.find()` the first match — the
 * entire posts table, deserialized out of the cache on every request of every
 * page on the site, to read one title and one slug. The predicate belongs in
 * SQL and `LIMIT 1` belongs with it.
 *
 * Rides the `'posts'` tag like every other post reader, so publishing swaps the
 * bar immediately rather than at the end of the revalidate window.
 */
const getLatestPostPromo = unstable_cache(
	async (): Promise<Promo | null> => {
		const [latest] = await db
			.select({
				title: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, "$.title"))`,
				slug: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, "$.slug"))`,
			})
			.from(contentResource)
			.where(
				and(
					eq(contentResource.type, 'post'),
					eq(
						sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`,
						'published',
					),
					eq(
						sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`,
						'public',
					),
				),
			)
			.orderBy(desc(contentResource.createdAt))
			.limit(1)

		if (!latest?.slug || !latest?.title) return null
		return { label: 'New', message: latest.title, href: `/${latest.slug}` }
	},
	['promo-bar-latest-post-v1'],
	{ revalidate: 3600, tags: ['posts'] },
)

/**
 * Site-wide announcement bar. The scheduled override switches in the browser
 * at its start instant, including for a page that was opened before launch.
 */
export async function PromoBar() {
	let fallbackPromo: Promo | null = null
	try {
		fallbackPromo = await getLatestPostPromo()
	} catch {
		fallbackPromo = null
	}

	if (!FEATURED_PROMO.startsAt && !FEATURED_PROMO.endsAt) {
		return <PromoBarContent promo={FEATURED_PROMO} />
	}

	return (
		<TimedPromoBarSwitch
			startsAt={FEATURED_PROMO.startsAt}
			endsAt={FEATURED_PROMO.endsAt}
			initialFeaturedActive={isPromoActive(FEATURED_PROMO)}
			featured={<PromoBarContent promo={FEATURED_PROMO} />}
			fallback={
				fallbackPromo ? <PromoBarContent promo={fallbackPromo} /> : null
			}
		/>
	)
}
