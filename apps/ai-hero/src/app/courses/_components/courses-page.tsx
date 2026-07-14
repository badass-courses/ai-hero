import * as React from 'react'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { ResourceRow } from '@/components/landing/resource-row'
import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import {
	COURSES_HERO,
	COURSES_NEWSLETTER,
	COURSE_TIERS,
} from '@/lib/courses-content'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'

import { FlagshipRow } from './flagship-row'

const MONO_LABEL =
	'font-mono text-[11px] font-medium uppercase tracking-wider opacity-60'

/**
 * /courses ("Learn with Matt") — the paid-offerings catalog, per Amy's
 * 3-tier course roadmap. Full-nav sales-adjacent page: NO sidebar, NO
 * breadcrumbs (her walkthrough: "Courses will be landing pages"). Sections:
 * hero → roadmap (tier strips + rows, full-bleed per DESIGN rule 1) →
 * trusted-by → newsletter bookend (the anchor target the coming-soon rows
 * scroll to). Designed to grow: a new tier is a config row in
 * courses-content.ts, or a live product once it publishes.
 */
export function CoursesPage({
	flagship,
	isPurchasable,
}: {
	flagship: UpcomingCohortSummary | null
	isPurchasable: boolean
}) {
	return (
		<main className="bg-background text-foreground">
			{/* 1. Hero */}
			<section className="border-b">
				<div className="flex flex-col gap-6 px-8 py-16 sm:px-16 md:py-24">
					<p className={MONO_LABEL}>{COURSES_HERO.eyebrow}</p>
					<h1 className="text-balance text-4xl font-normal leading-[1.05] tracking-tight sm:text-5xl">
						{COURSES_HERO.title}
					</h1>
					<p className="text-foreground/80 max-w-[60ch] text-lg leading-relaxed">
						{COURSES_HERO.intro}
					</p>
				</div>
			</section>

			{/* 2. Roadmap — padded text blocks, full-bleed rows */}
			<section
				aria-labelledby="courses-roadmap-heading"
				className="border-b pb-16 md:pb-20"
			>
				<div className="flex flex-col gap-3 px-8 py-16 sm:px-16">
					<p className={MONO_LABEL}>The roadmap</p>
					<h2
						id="courses-roadmap-heading"
						className="text-balance text-3xl font-medium leading-tight tracking-tight sm:text-4xl"
					>
						Three courses. One path.
					</h2>
					<p className="text-foreground/80 max-w-[65ch] text-base leading-relaxed sm:text-lg">
						Start from zero, level up to the flagship cohort, then bring the
						whole system to your team.
					</p>
				</div>

				{COURSE_TIERS.map((tier) => (
					<React.Fragment key={tier.tier}>
						<div className="px-8 pb-4 pt-8 sm:px-16">
							<p className={MONO_LABEL}>{tier.label}</p>
						</div>
						{tier.status === 'flagship' ? (
							<FlagshipRow flagship={flagship} isPurchasable={isPurchasable} />
						) : (
							<ResourceRow
								title={tier.title}
								description={tier.description}
								href={`#${COURSES_NEWSLETTER.anchorId}`}
								typeLabel={tier.audienceLabel}
								badge="Coming soon"
								fallbackPlaceholder="Coming soon"
							/>
						)}
					</React.Fragment>
				))}
			</section>

			{/* 3. Trusted by (full-bleed, same usage as /skills) */}
			<CompanyLogoGrid className="pt-6" />

			{/* 4. Newsletter bookend — the coming-soon rows' anchor target */}
			<section
				id={COURSES_NEWSLETTER.anchorId}
				className="scroll-mt-24 border-t"
			>
				<div className="px-8 py-16 sm:px-16 md:py-24">
					<PrimaryNewsletterCta
						title={COURSES_NEWSLETTER.title}
						byline={COURSES_NEWSLETTER.byline}
						titleElement="h2"
						trackProps={{ event: 'courses_bookend_newsletter' }}
					/>
				</div>
			</section>
		</main>
	)
}
