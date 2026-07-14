import * as React from 'react'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { MoreWaysLink } from '@/app/learn/_components/more-ways-link'
import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import {
	COURSES_COMING_NEXT,
	COURSES_HERO,
	COURSES_NEWSLETTER,
	COURSES_TESTIMONIALS,
	FLAGSHIP_FACTS,
	FLAGSHIP_SECTION,
	FLAGSHIP_TEAM,
} from '@/lib/courses-content'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { Star } from 'lucide-react'

import { FlagshipRow } from './flagship-row'

const MONO_LABEL =
	'font-mono text-[11px] font-medium uppercase tracking-wider opacity-60'

/**
 * /courses ("Learn with Matt") — v2, centered on the one product that exists
 * today: the flagship cohort. Full-nav sales-adjacent page: NO sidebar, NO
 * breadcrumbs (Amy: "Courses will be landing pages"). Copy is grounded in
 * voice-of-customer mining (see courses-content.ts). Sections: hero →
 * flagship (row + live meta + objection-facts grid + team strip) → real
 * testimonials → trusted-by → coming-next note → newsletter bookend (the
 * waitlist queue).
 */
export function CoursesPage({
	flagship,
	isPurchasable,
	alumniLabel,
}: {
	flagship: UpcomingCohortSummary | null
	isPurchasable: boolean
	/** e.g. "8,500+" — null hides the stat. */
	alumniLabel: string | null
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

			{/* 2. Flagship cohort */}
			<section aria-labelledby="flagship-heading" className="border-b">
				<div className="flex flex-col gap-3 px-8 py-16 sm:px-16">
					<p className={MONO_LABEL}>{FLAGSHIP_SECTION.eyebrow}</p>
					<h2
						id="flagship-heading"
						className="text-balance text-3xl font-medium leading-tight tracking-tight sm:text-4xl"
					>
						{FLAGSHIP_SECTION.heading}
					</h2>
					<p className="text-foreground/80 max-w-[65ch] text-base leading-relaxed sm:text-lg">
						{FLAGSHIP_SECTION.strapline}
					</p>
				</div>

				{/* Live product row (price/dates when purchasable, waitlist otherwise) */}
				<FlagshipRow flagship={flagship} isPurchasable={isPurchasable} />

				{/* Live meta strip */}
				<div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-8 pb-2 pt-6 sm:px-16">
					{alumniLabel ? (
						<span className={MONO_LABEL}>
							{alumniLabel} engineers trained across all cohorts
						</span>
					) : null}
					<span className={MONO_LABEL}>
						{isPurchasable
							? 'Enrolling now'
							: 'Waitlist gets the dates first'}
					</span>
				</div>

				{/* Objection facts — hairline 2-col grid */}
				<div className="border-border bg-border mt-6 grid grid-cols-1 gap-px border-y sm:grid-cols-2">
					{FLAGSHIP_FACTS.map((fact) => (
						<div
							key={fact.label}
							className="bg-background flex flex-col gap-2 px-8 py-8 sm:px-16"
						>
							<h3 className={MONO_LABEL}>{fact.label}</h3>
							<p className="text-foreground/80 max-w-[55ch] text-base leading-relaxed">
								{fact.body}
							</p>
						</div>
					))}
				</div>

				{/* Team strip */}
				<div className="flex flex-col gap-3 px-8 py-12 sm:px-16">
					<h3 className="text-balance text-xl font-medium leading-tight tracking-tight sm:text-2xl">
						{FLAGSHIP_TEAM.heading}
					</h3>
					<p className="text-foreground/80 max-w-[65ch] text-base leading-relaxed">
						{FLAGSHIP_TEAM.body}
					</p>
					<div className="pt-1">
						<MoreWaysLink
							href={FLAGSHIP_TEAM.href}
							label={FLAGSHIP_TEAM.linkLabel}
						/>
					</div>
				</div>
			</section>

			{/* 3. Real cohort-student testimonials — hairline pair */}
			<section aria-label="What cohort students say" className="border-b">
				<div className="border-border bg-border grid grid-cols-1 gap-px sm:grid-cols-2">
					{COURSES_TESTIMONIALS.map((testimonial) => (
						<figure
							key={testimonial.author}
							className="bg-background flex flex-col gap-5 px-8 py-12 sm:px-16"
						>
							<div
								aria-hidden
								className="flex items-center gap-1 text-[#ffcf77]"
							>
								{Array.from({ length: 5 }).map((_, index) => (
									<Star key={index} className="size-4 fill-[#ffcf77]" />
								))}
							</div>
							<blockquote className="text-balance text-xl font-medium leading-snug tracking-tight not-italic sm:text-2xl">
								&ldquo;{testimonial.quote}&rdquo;
							</blockquote>
							<figcaption className="text-base opacity-70">
								{testimonial.author}
							</figcaption>
						</figure>
					))}
				</div>
			</section>

			{/* 4. Trusted by (full-bleed, same usage as /skills) */}
			<CompanyLogoGrid className="pt-6" />

			{/* 5. Coming next — one honest line, no roadmap theater */}
			<section className="border-t">
				<div className="flex flex-col gap-2 px-8 py-10 sm:px-16">
					<p className={MONO_LABEL}>{COURSES_COMING_NEXT.eyebrow}</p>
					<p className="text-foreground/80 max-w-[65ch] text-base leading-relaxed sm:text-lg">
						{COURSES_COMING_NEXT.body}
					</p>
				</div>
			</section>

			{/* 6. Newsletter bookend — the waitlist queue */}
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
