import * as React from 'react'
import Link from 'next/link'
import { SKILLS_MINI_COURSE_CTA } from '@/lib/skills-content'
import { ArrowRight } from 'lucide-react'

/**
 * Free skills mini-course CTA for the /skills landing (spec §7 step 5). Copy
 * and destination live in SKILLS_MINI_COURSE_CTA (skills-content.ts); the
 * default href is a placeholder flagged for Vojta. Monochrome on tokens,
 * square corners (DESIGN.md).
 */
export function SkillsMiniCourseCta() {
	const { heading, subheading, href, ctaLabel } = SKILLS_MINI_COURSE_CTA
	const isExternal = /^https?:\/\//i.test(href)

	return (
		<section aria-labelledby="skills-mini-course-heading" className="border-b">
			<div className="flex flex-col items-start gap-6 px-8 py-16 sm:px-16 md:py-24">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Free mini-course
				</span>
				<h2
					id="skills-mini-course-heading"
					className="text-balance font-sans text-3xl font-medium leading-tight tracking-tight sm:text-4xl"
				>
					{heading}
				</h2>
				<p className="max-w-[65ch] text-base leading-relaxed opacity-80 sm:text-lg">
					{subheading}
				</p>
				<Link
					href={href}
					target={isExternal ? '_blank' : undefined}
					rel={isExternal ? 'noopener noreferrer' : undefined}
					className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring group inline-flex items-center gap-2 px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					<span>{ctaLabel}</span>
					<ArrowRight
						aria-hidden
						className="size-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5"
					/>
				</Link>
			</div>
		</section>
	)
}
