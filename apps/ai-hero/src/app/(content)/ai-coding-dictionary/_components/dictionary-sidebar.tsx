'use client'

import * as React from 'react'
import { useSearchBox } from 'react-instantsearch'

import { cn } from '@coursebuilder/ui/utils/cn'

import type { DictionarySection } from '@/lib/ai-coding-dictionary'
import { DictionarySearchBox } from './dictionary-search-box'
import { sectionId } from './section-id'

export function DictionarySidebar({
	sections,
}: {
	sections: DictionarySection[]
}) {
	return (
		<aside className="border-border bg-background lg:sticky lg:top-(--nav-height) lg:self-start lg:max-h-[calc(100vh-var(--nav-height))] lg:overflow-y-auto">
			<div className="border-border hidden border-b lg:block">
				<DictionarySearchBox />
			</div>
			<DictionarySectionNav sections={sections} />
		</aside>
	)
}

function DictionarySectionNav({ sections }: { sections: DictionarySection[] }) {
	const { query: rawQuery } = useSearchBox()
	const isSearching = Boolean(rawQuery.trim())

	const sectionIds = React.useMemo(
		() => sections.map((section) => sectionId(section.title)),
		[sections],
	)

	const activeId = useActiveSection(sectionIds)

	return (
		<nav aria-label="Dictionary sections" className="flex flex-col">
			<p className="text-muted-foreground border-border border-b px-6 py-3 font-mono text-[10px] font-medium uppercase tracking-wider">
				Sections
			</p>
			<ul className="flex flex-col">
				{sections.map((section) => {
					const id = sectionId(section.title)
					const isActive = !isSearching && activeId === id
					return (
						<li key={section.title} className="border-border border-b">
							<a
								href={isSearching ? undefined : `#${id}`}
								aria-disabled={isSearching || undefined}
								className={cn(
									'group flex items-center justify-between gap-3 px-6 py-3 text-sm transition-colors',
									isSearching
										? 'text-muted-foreground/50 pointer-events-none'
										: 'text-muted-foreground hover:text-foreground hover:bg-muted/30',
									isActive && 'text-foreground bg-muted/40',
								)}
							>
								<span className="flex min-w-0 items-center gap-2">
									<span
										aria-hidden
										className={cn(
											'text-primary opacity-50 transition-opacity',
											isActive && 'opacity-100',
										)}
									>
										#
									</span>
									<span className="truncate font-medium">{section.title}</span>
								</span>
								<span className="text-muted-foreground/70 font-mono text-[10px] tabular-nums">
									{section.entries.length}
								</span>
							</a>
						</li>
					)
				})}
			</ul>
		</nav>
	)
}

/**
 * Tracks which section the reader is currently looking at.
 *
 * Each section element is observed for intersection with a band that runs
 * from just under the sticky nav to roughly the middle of the viewport. A
 * section's id lands in `visibleSet` while any part of it overlaps that
 * band, and `activeId` resolves to the FIRST visible id in document order —
 * so a tall section keeps the highlight the whole time it's on screen,
 * not just while its header is in view.
 *
 * When nothing is visible (e.g. between long sections during fast scroll)
 * we keep the last known active id rather than snapping to nothing.
 */
function useActiveSection(sectionIds: string[]): string | null {
	const [visibleSet, setVisibleSet] = React.useState<Set<string>>(
		() => new Set(),
	)
	const [activeId, setActiveId] = React.useState<string | null>(
		sectionIds[0] ?? null,
	)

	React.useEffect(() => {
		if (typeof window === 'undefined') return
		if (typeof IntersectionObserver === 'undefined') return

		const elements = sectionIds
			.map((id) => document.getElementById(id))
			.filter((el): el is HTMLElement => Boolean(el))
		if (elements.length === 0) return

		const observer = new IntersectionObserver(
			(entries) => {
				setVisibleSet((prev) => {
					const next = new Set(prev)
					for (const entry of entries) {
						if (entry.isIntersecting) next.add(entry.target.id)
						else next.delete(entry.target.id)
					}
					return next
				})
			},
			{ rootMargin: '-10% 0% -50% 0%', threshold: 0 },
		)

		elements.forEach((el) => observer.observe(el))
		return () => observer.disconnect()
	}, [sectionIds])

	React.useEffect(() => {
		for (const id of sectionIds) {
			if (visibleSet.has(id)) {
				setActiveId(id)
				return
			}
		}
	}, [sectionIds, visibleSet])

	return activeId
}
