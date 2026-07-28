import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import {
	SKILL_PHASE_UTILITY_NUMBER,
	type SkillEntry,
	type SkillPhase,
} from '@/lib/skills-shared'

import { cn } from '@coursebuilder/utils/cn'

/**
 * "Where this fits" — the second block of a skill page's right rail (redesign
 * README §6), under the section TOC. It answers one question: of the phases the
 * workflow has, which one is this skill?
 *
 * The phase set is DERIVED from the CMS phase tags on the skills list rather
 * than hardcoded to the design's four (idea / spec / build / review). The tags
 * are the source of truth and the site currently runs more than four; a
 * hardcoded ladder would quietly start lying the first time Matt adds one.
 * Utility skills (phase 99) are not a step in the workflow, so they never
 * appear as a rung — a utility skill simply renders no marked phase.
 */
export function SkillPhaseRail({
	phases,
	current,
	className,
}: {
	/** Ordered workflow phases. Use `workflowPhases(entries)` to build it. */
	phases: SkillPhase[]
	/** This skill's phase, or null when the post carries no phase tag. */
	current?: SkillPhase | null
	className?: string
}) {
	if (phases.length === 0) return null

	// A one-track grid, not a block: `minmax(0,1fr)` is what stops the
	// horizontal scroller below from contributing its full width as a
	// min-content size and blowing out whichever cell the rail is dropped into.
	// `min-width: 0` on the scroller itself does not do it.
	return (
		<section
			aria-label="Where this fits"
			className={cn('grid grid-cols-[minmax(0,1fr)]', className)}
		>
			<p className={cn(TYPE.micro, 'mb-3 text-[color:var(--ah-fg-label)]')}>
				Where this fits
			</p>
			{/* Below the rail's own breakpoint the list rotates into a horizontal
			    scroller (spec `.ah-scroller`) — four stacked rows of mono label eat
			    a third of a phone screen for metadata nobody came for. */}
			<ol className="flex snap-x snap-proximity gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden min-[901px]:flex-col min-[901px]:gap-[7px] min-[901px]:overflow-visible">
				{phases.map((phase) => {
					const isCurrent = current?.number === phase.number
					return (
						<li
							key={phase.slug}
							aria-current={isCurrent ? 'step' : undefined}
							className="flex flex-none snap-start items-center gap-2.5 min-[901px]:flex-auto"
						>
							<span
								aria-hidden
								className={cn(
									'size-[7px] flex-none rounded-full',
									isCurrent ? 'bg-primary' : 'bg-foreground/20',
								)}
							/>
							<span
								className={cn(
									TYPE.command,
									'whitespace-nowrap',
									isCurrent
										? 'text-primary'
										: 'text-[color:var(--ah-fg-label)]',
								)}
							>
								Phase {phase.number} · {phase.name}
							</span>
						</li>
					)
				})}
			</ol>
		</section>
	)
}

/**
 * The workflow ladder implied by a set of skill entries: every distinct
 * numbered phase tag, in number order. Utility (99) is dropped — it is a
 * bucket, not a step.
 */
export function workflowPhases(entries: SkillEntry[]): SkillPhase[] {
	const byNumber = new Map<number, SkillPhase>()

	for (const entry of entries) {
		const phase = entry.phase
		if (!phase || phase.number === SKILL_PHASE_UTILITY_NUMBER) continue
		if (!byNumber.has(phase.number)) byNumber.set(phase.number, phase)
	}

	return [...byNumber.values()].sort((a, b) => a.number - b.number)
}
