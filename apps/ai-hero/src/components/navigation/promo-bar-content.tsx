import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import type { Promo } from './promo-config'

/** The bar's one row. Shared by the site promo and a recipient's transfer. */
export function PromoBarContent({ promo }: { promo: Promo }) {
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
					// The bar is on every page and this href is a `/s/` shortlink that
					// 307s to the product page. Prefetching it fetched the product page's
					// RSC payload on every pageview, and that payload's client references
					// then preloaded the Mux player (300KB+ gz) and the workshop UI —
					// on pages with no video at all.
					prefetch={false}
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
