'use client'

import * as React from 'react'
import { Sparkles } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { AskAIHeroBot } from './ask-ai-hero-bot'

/**
 * MapToc — flat anchor TOC for the Map page (spec §3.2).
 *
 * Renders the goal-section TOC as plain `#{id}` anchor links, with an
 * active-section highlight driven by a LOCAL `IntersectionObserver` scoped to
 * `[data-goal-section]` elements (the page tags each goal `<section>`).
 *
 * Two deliberate divergences from the article `post-toc.tsx`:
 *   1. NOT sticky — per the wireframe mobile note, one sticky element (the nav
 *      bar) is enough; the goal TOC scrolls away.
 *   2. NOT coupled to `useActiveHeadingContext` — that shared provider is
 *      purpose-built for markdown article bodies; a local observer keeps this
 *      static goal list from risking regressions there.
 *
 * The "Ask AIHero Bot" trigger sits directly below the list, in the same block.
 * MapToc owns the bot's open state and forwards its data props.
 */

export interface MapTocItem {
	/** Anchor target — matches the goal `<section>`'s `id` / `#{id}`. */
	id: string
	/** Visible label (the goal question). */
	label: string
}

export interface MapTocProps {
	/** TOC entries, in document order. Typically `TOC_ITEMS` from goal-sections-data. */
	items: MapTocItem[]
	/** Curated "Try asking" prompts, forwarded to the bot (spec §4.1). */
	suggestions: string[]
	/** Goal-section item slugs, forwarded to the bot for Map-linked boost. */
	boostSlugs: string[]
	className?: string
}

export function MapToc({
	items,
	suggestions,
	boostSlugs,
	className,
}: MapTocProps) {
	const [activeId, setActiveId] = React.useState<string | null>(null)
	const [botOpen, setBotOpen] = React.useState(false)

	React.useEffect(() => {
		if (items.length === 0) return
		const sections = Array.from(
			document.querySelectorAll<HTMLElement>('[data-goal-section]'),
		).filter((el) => el.id)
		if (sections.length === 0) return

		const visible = new Set<string>()
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = entry.target.id
					if (!id) continue
					if (entry.isIntersecting) visible.add(id)
					else visible.delete(id)
				}
				// Highlight the first section in TOC order that is currently in view.
				const first = items.find((item) => visible.has(item.id))
				if (first) setActiveId(first.id)
			},
			// Activate a section once its top crosses ~40% down the viewport; the
			// bottom margin keeps the last short section from never activating.
			{ rootMargin: '-64px 0px -55% 0px', threshold: 0 },
		)
		sections.forEach((section) => observer.observe(section))
		return () => observer.disconnect()
	}, [items])

	if (items.length === 0) return null

	return (
		<nav
			aria-label="On this page"
			className={cn('border-b', className)}
		>
			<div className="flex flex-col gap-6 px-8 py-10 sm:px-16">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					On this page
				</p>
				<ul className="flex flex-col gap-1">
					{items.map((item) => {
						const active = item.id === activeId
						return (
							<li key={item.id}>
								<a
									href={`#${item.id}`}
									aria-current={active ? 'location' : undefined}
									className={cn(
										'focus-visible:ring-ring block py-1.5 text-base leading-snug tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2 sm:text-lg [overflow-wrap:anywhere]',
										active
											? 'text-foreground font-medium'
											: 'text-foreground/60 hover:text-foreground',
									)}
								>
									{item.label}
								</a>
							</li>
						)
					})}
				</ul>
				<div>
					<button
						type="button"
						onClick={() => setBotOpen(true)}
						className="focus-visible:ring-ring inline-flex items-center gap-2 border px-4 py-2.5 text-sm font-medium tracking-tight transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						<Sparkles aria-hidden className="size-4 shrink-0" />
						Ask AIHero Bot
					</button>
				</div>
			</div>

			<AskAIHeroBot
				open={botOpen}
				onOpenChange={setBotOpen}
				suggestions={suggestions}
				boostSlugs={boostSlugs}
			/>
		</nav>
	)
}
