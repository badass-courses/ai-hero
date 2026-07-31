import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import type { SkillSection } from '@/lib/skills-query'

import { cn } from '@coursebuilder/utils/cn'

/**
 * "Where this fits" — the second block of a skill page's right rail (redesign
 * README §6), under the section TOC. It answers one question: of the groups the
 * skill set has, which one is this skill in, and where in it?
 *
 * The rungs are the SKILLS LIST'S SECTIONS (Getting Started, The Main Flow,
 * Shaping, …). This used to render the `skill-phase` tag ladder, which could
 * only answer for the 6 of 21 listed skills that carry a phase tag — /teach and
 * the rest got a block headed "Where this fits" that then fit nothing. Sections
 * are the live taxonomy and every listed skill is in one, so every skill gets a
 * real answer. See `getSkillSectionMap`.
 */
export function SkillSectionRail({
	sections,
	current,
	className,
}: {
	/** Titled sections in list order. Use `getSkillSectionMap()`. */
	sections: SkillSection[]
	/** This skill's placement, or null when it is unlisted or loose. */
	current?: { sectionId: string; position: number } | null
	className?: string
}) {
	if (sections.length === 0) return null

	const currentSection = current
		? sections.find((section) => section.id === current.sectionId)
		: undefined

	// A one-track grid, not a block: `minmax(0,1fr)` is what stops the
	// horizontal scroller below from contributing its full width as a
	// min-content size and blowing out whichever cell the rail is dropped into.
	// `min-width: 0` on the scroller itself does not do it.
	return (
		<section
			aria-label="Where this fits"
			className={cn('grid grid-cols-[minmax(0,1fr)]', className)}
		>
			<p className={cn(TYPE.groupLabel, 'mb-3')}>
				Where this fits
			</p>
			{/* Below the rail's own breakpoint the list rotates into a horizontal
			    scroller (spec `.ah-scroller`) — six stacked rows of mono label eat
			    a third of a phone screen for metadata nobody came for. */}
			<ol className="flex snap-x snap-proximity gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden min-[901px]:flex-col min-[901px]:gap-[7px] min-[901px]:overflow-visible">
				{sections.map((section) => {
					const isCurrent = currentSection?.id === section.id
					// The rung goes to the section's FIRST skill — its entry point.
					// Two cases stay unlinked rather than link somewhere useless: a
					// section with no members, and the rung the reader is standing on
					// when they are already its first skill (a link to this page).
					const isSelf = isCurrent && current?.position === 1
					const href =
						section.firstSlug && !isSelf ? `/${section.firstSlug}` : null
					const dot = (
						<span
							aria-hidden
							className={cn(
								'size-[7px] flex-none rounded-full transition-colors',
								isCurrent ? 'bg-primary' : 'bg-foreground/20',
							)}
						/>
					)
					// One label, whether or not it is inside a link: an extra wrapper
					// element around it is an INLINE box, and its strut is set from the
					// row's inherited font size rather than the label's 12px mono — it
					// made every linked rung taller than the unlinked one.
					const label = (
						<span
							className={cn(
								TYPE.command,
								'whitespace-nowrap transition-colors',
								isCurrent ? 'text-primary' : 'text-[color:var(--ah-fg-label)]',
								href && 'group-hover:text-foreground',
							)}
						>
							{section.title}
						</span>
					)
					// The row's box is identical in both branches — flex, same gap, no
					// padding, no leading of its own — so linking a rung changes what it
					// does and nothing about how it sits.
					const rowClass = 'flex items-center gap-2.5'
					return (
						<li
							key={section.id}
							aria-current={isCurrent ? 'step' : undefined}
							className="flex flex-none snap-start items-center min-[901px]:flex-auto"
						>
							{href ? (
								// The whole rung is the target, dot included: a 7px circle
								// beside a mono label is two hit areas where the reader sees
								// one row.
								<Link
									href={href}
									className={cn(
										rowClass,
										'focus-visible:ring-ring group rounded-sm focus-visible:outline-none focus-visible:ring-2',
									)}
								>
									{dot}
									{label}
								</Link>
							) : (
								<span className={rowClass}>
									{dot}
									{label}
								</span>
							)}
						</li>
					)
				})}
			</ol>
		</section>
	)
}
