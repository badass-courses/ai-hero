import { unstable_cache } from 'next/cache'
import Link from 'next/link'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import { ArrowRight } from 'lucide-react'

import { FEATURED_PROMO, type Promo } from './promo-config'

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
 * Resolve the single active promo, server-side: a manual override wins,
 * otherwise the latest published, public post. Cached query, no cookies → no
 * forced dynamic rendering, no layout shift.
 */
async function getActivePromo(): Promise<Promo | null> {
	if (FEATURED_PROMO) return FEATURED_PROMO
	try {
		return await getLatestPostPromo()
	} catch {
		return null
	}
}

/**
 * Site-wide announcement bar. Server component rendered above the nav in the
 * root layout; full-width, not sticky (scrolls away while the nav stays
 * pinned), and not dismissible.
 *
 * NOTE: `PromoBarSlot` hides this on `minimal` routes (editors, admin, auth),
 * but that gate is on the CLIENT — this component still executes there, because
 * the root layout has no pathname to branch on without calling `headers()` and
 * opting the whole site out of static rendering. Affordable now that the query
 * above is one indexed row; it was not when this read the entire posts table.
 */
export async function PromoBar() {
	const promo = await getActivePromo()
	if (!promo) return null

	return (
		// Shell width matches `LayoutClient`: a 1440px bordered box plus 2×8px of
		// page-background gutter either side.
		<aside
			aria-label="Announcement"
			className="relative mx-auto w-full max-w-[1456px] px-2 print:hidden"
		>
			<div className="bg-muted/40 border-border flex h-[34px] items-center justify-center gap-2.5 border-x border-b px-4 text-center text-[12.5px] leading-none">
				{/* Gold in both themes: `--primary` goes ink on paper, and an
				    ink-filled "NEW" chip reads as a disabled state rather than as
				    the one new thing on the site. */}
				{promo.label && (
					<span className="bg-accent-fill text-accent-fill-foreground inline-flex shrink-0 items-center rounded-[4px] px-1.5 py-1 font-mono text-[9px] font-medium uppercase leading-none tracking-[0.1em]">
						{promo.label}
					</span>
				)}
				<Link
					href={promo.href}
					className="group focus-visible:ring-ring inline-flex min-w-0 items-center gap-1.5 font-medium tracking-tight underline-offset-4 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					<span className="truncate">{promo.message}</span>
					<ArrowRight
						aria-hidden
						className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
					/>
				</Link>
			</div>
		</aside>
	)
}
