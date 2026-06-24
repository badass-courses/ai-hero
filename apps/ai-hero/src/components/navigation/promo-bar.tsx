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
		<aside
			aria-label="Announcement"
			className="bg-muted/40 border-border w-full border-b print:hidden"
		>
			<div className="mx-auto flex max-w-[1200px] items-center justify-center gap-2.5 px-4 py-2.5 text-center text-sm">
				{promo.label && (
					<span className="bg-primary text-primary-foreground inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider">
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
