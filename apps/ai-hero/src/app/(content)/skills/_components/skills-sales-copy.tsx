import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { SKILLS_SALES_COPY } from '@/lib/skills-content'

import { cn } from '@coursebuilder/utils/cn'

/**
 * WHAT A SKILL IS (`Skills Page.dc.html` § WHAT A SKILL IS).
 *
 * The section has no heading: an eyebrow, then the answer as one paragraph at
 * `TYPE.statement`. A reader who has just installed something wants the
 * definition, not a title telling them a definition is coming.
 *
 * Under it, the argument in three cells (problem / fix / why it compounds) as
 * a hairline grid, and then the compatibility note as a single card — the one
 * objection ("does this work in my editor?") answered where it is asked,
 * rather than in a section of its own.
 */
export function SkillsSalesCopy() {
	const { eyebrow, lead, blocks, compatibility } = SKILLS_SALES_COPY

	return (
		<section aria-labelledby="skills-sales-heading" className="border-b">
			<div className="px-8 pb-10 pt-11 sm:px-11">
				<p
					id="skills-sales-heading"
					className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}
				>
					{eyebrow}
				</p>
				<p
					className={cn(
						TYPE.statement,
						'mb-[30px] mt-[18px] max-w-[64ch] text-pretty',
					)}
				>
					{lead}
				</p>

				{/* Hairline grid, inset in the gutter rather than full-bleed: this is
				    a slab of argument sitting ON the page, so it takes the panel
				    radius (DESIGN rule 12). */}
				<div className="border-border bg-border grid gap-px overflow-hidden rounded-lg border sm:grid-cols-[repeat(3,minmax(0,1fr))]">
					{blocks.map((block) => (
						<div
							key={block.heading}
							className="bg-background px-[22px] pb-6 pt-[22px]"
						>
							<h3 className={cn(TYPE.micro, 'text-primary mb-[11px]')}>
								{block.heading}
							</h3>
							<p
								className={cn(
									TYPE.metaProse,
									'text-[color:var(--ah-fg-muted)]',
								)}
							>
								{block.body}
							</p>
						</div>
					))}
				</div>

				<div className="border-input bg-card mt-4 flex flex-wrap items-center gap-[18px] rounded-md border px-5 py-4">
					<div className="flex-none">
						<h3 className={cn(TYPE.cardTitle, 'mb-[3px]')}>
							{compatibility.heading}
						</h3>
						<p
							className={cn(TYPE.metaSm, 'text-[color:var(--ah-fg-subtle)]')}
						>
							{compatibility.body}
						</p>
					</div>
					<ul className="flex flex-wrap gap-[7px] sm:ml-auto">
						{compatibility.agents.map((agent) => (
							<li
								key={agent}
								className={cn(
									TYPE.command,
									'border-input bg-muted inline-flex items-center rounded-sm border px-[9px] py-1.5 text-[color:var(--ah-fg-body)]',
								)}
							>
								{agent}
							</li>
						))}
					</ul>
				</div>
			</div>
		</section>
	)
}
