import * as React from 'react'
import { SKILLS_SALES_COPY } from '@/lib/skills-content'

/**
 * Sales-copy block for the /skills landing (spec §7 step 2). A single
 * continuous editorial block: eyebrow + lead, three mini-headline sections,
 * and a multi-agent compatibility note. Pure copy, no data dependency —
 * fed entirely by SKILLS_SALES_COPY in skills-content.ts.
 */
export function SkillsSalesCopy() {
	const { eyebrow, lead, blocks, compatibility } = SKILLS_SALES_COPY

	return (
		<section
			aria-labelledby="skills-sales-heading"
			className="border-b"
		>
			<div className="mx-auto flex max-w-3xl flex-col gap-10 px-8 py-16 sm:px-16 md:py-24">
				<div className="flex flex-col gap-4">
					<p
						id="skills-sales-heading"
						className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60"
					>
						{eyebrow}
					</p>
					<p className="text-balance text-2xl font-light leading-snug tracking-tight sm:text-3xl">
						{lead}
					</p>
				</div>

				<div className="border-border bg-border grid gap-px border-y sm:grid-cols-3">
					{blocks.map((block) => (
						<div
							key={block.heading}
							className="bg-background flex flex-col gap-3 px-6 py-8 sm:px-6"
						>
							<h3 className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
								{block.heading}
							</h3>
							<p className="text-base leading-relaxed opacity-80">
								{block.body}
							</p>
						</div>
					))}
				</div>

				<div className="flex flex-col gap-4">
					<h3 className="text-balance text-xl font-medium leading-tight tracking-tight sm:text-2xl">
						{compatibility.heading}
					</h3>
					<p className="max-w-[65ch] text-base leading-relaxed opacity-80 sm:text-lg">
						{compatibility.body}
					</p>
					<ul className="mt-1 flex flex-wrap gap-2">
						{compatibility.agents.map((agent) => (
							<li
								key={agent}
								className="border-border bg-muted/40 inline-flex items-center px-3 py-1.5 font-mono text-xs font-medium tracking-tight opacity-80"
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
