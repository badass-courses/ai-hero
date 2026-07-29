import Link from 'next/link'
import { type Post } from '@/lib/posts'
import { getCachedAllPosts } from '@/lib/posts-query'
import { ArrowRight } from 'lucide-react'

import { FEATURED_PROMO, type Promo } from './promo-config'

/**
 * Resolve the single active promo, server-side: a manual override wins,
 * otherwise the latest published, public post. Cached query, no cookies → no
 * forced dynamic rendering, no layout shift.
 */
async function getActivePromo(): Promise<Promo | null> {
	if (FEATURED_PROMO) return FEATURED_PROMO
	try {
		const posts: Post[] = await getCachedAllPosts()
		const latest = posts.find(
			(p: Post) =>
				p?.fields?.state === 'published' &&
				p?.fields?.visibility === 'public' &&
				Boolean(p?.fields?.slug) &&
				Boolean(p?.fields?.title),
		)
		if (!latest) return null
		return {
			label: 'New',
			message: latest.fields.title,
			href: `/${latest.fields.slug}`,
		}
	} catch {
		return null
	}
}

/**
 * Site-wide announcement bar. Server component rendered above the nav in the
 * root layout; full-width, not sticky (scrolls away while the nav stays
 * pinned), and not dismissible.
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
