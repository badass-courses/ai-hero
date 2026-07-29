'use client'

import * as React from 'react'
import { ArrowDown } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { TYPE } from '@/components/landing/type'

/**
 * MapQuestionGrid — the Map page's table of contents, drawn as a 2×2 grid of
 * jump-link cards under the hero (spec `.ah-row` / `.ah-row--active`).
 *
 * A grid of numbered cards rather than a text list because the questions ARE
 * the page's offer: as a list under the hero they read as chrome the eye skips
 * on its way to the first section.
 *
 * Active card is driven by a LOCAL `IntersectionObserver` scoped to
 * `[data-goal-section]` elements (the page tags each goal `<section>`), so the
 * accent follows the reader down the page. Before anything intersects — i.e.
 * sitting at the top — the first card carries it.
 *
 * Deliberately NOT coupled to `useActiveHeadingContext`: that shared provider
 * is purpose-built for markdown article bodies, and a local observer keeps this
 * static goal list from risking regressions there.
 */

export interface MapTocItem {
	/** Anchor target — matches the goal `<section>`'s `id` / `#{id}`. */
	id: string
	/** Visible label (the goal question). */
	label: string
}

export interface MapQuestionGridProps {
	/** Entries, in document order. Typically `TOC_ITEMS` from goal-sections-data. */
	items: MapTocItem[]
	className?: string
}

export function MapQuestionGrid({ items, className }: MapQuestionGridProps) {
	const [activeId, setActiveId] = React.useState<string | null>(null)

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
				// Highlight the first section in list order that is currently in view.
				const first = items.find((item) => visible.has(item.id))
				setActiveId(first ? first.id : null)
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
			className={cn('grid max-w-[800px] gap-2.5 sm:grid-cols-2', className)}
		>
			{items.map((item, index) => {
				const active = activeId ? item.id === activeId : index === 0
				return (
					<a
						key={item.id}
						href={`#${item.id}`}
						aria-current={active ? 'location' : undefined}
						className={cn(
							'focus-visible:ring-ring flex items-center gap-3 rounded-md border px-4 py-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
							active
								? 'border-[color:var(--ah-accent-line)] bg-[color:var(--ah-accent-wash)]'
								: 'border-border hover:border-foreground/20',
						)}
					>
						<span
							className={cn(
								TYPE.command,
								'shrink-0',
								active ? 'text-primary' : 'text-[color:var(--ah-fg-faint)]',
							)}
						>
							{String(index + 1).padStart(2, '0')}
						</span>
						<span
							className={cn(
								TYPE.bodyTight,
								active ? 'text-foreground' : 'text-foreground/85',
							)}
						>
							{item.label}
						</span>
						<ArrowDown
							aria-hidden
							className={cn(
								'ml-auto size-4 shrink-0',
								active ? 'text-primary' : 'text-[color:var(--ah-fg-faint)]',
							)}
						/>
					</a>
				)
			})}
		</nav>
	)
}
