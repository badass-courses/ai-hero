import { unstable_cache } from 'next/cache'
import Link from 'next/link'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import { ArrowRight } from 'lucide-react'

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

function PromoBarContent({ promo }: { promo: Promo }) {
	return (
		<aside
			aria-label="Announcement"
			className="relative mx-auto w-full max-w-[1456px] px-2 print:hidden"
		>
			<div className="bg-muted/40 border-border flex h-[34px] items-center justify-center gap-2.5 border-x border-b px-4 text-center text-[12.5px] leading-none">
				{promo.label && (
					<span className="text-primary inline-flex shrink-0 items-center rounded-[4px] border border-[color:var(--ah-accent-line)] px-1.5 py-1 font-mono text-[9px] font-medium uppercase leading-none tracking-[0.1em]">
						{promo.label}
					</span>
				)}
				<Link
					href={promo.href}
					className="group focus-visible:ring-ring inline-flex min-w-0 items-center gap-1.5 font-medium tracking-tight underline-offset-4 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					<span className="truncate leading-[1.4]">{promo.message}</span>
					<ArrowRight
						aria-hidden
						className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
					/>
				</Link>
			</div>
		</aside>
	)
}

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
