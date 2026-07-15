import * as React from 'react'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { MoreWaysLink } from '@/app/learn/_components/more-ways-link'
import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import {
	COURSES_COMING_NEXT,
	COURSES_HERO,
	COURSES_NEWSLETTER,
	COURSES_TESTIMONIALS,
	COURSES_TESTIMONIALS_EYEBROW,
	FLAGSHIP_FACTS,
	FLAGSHIP_SECTION,
	FLAGSHIP_STATS,
	FLAGSHIP_TEAM,
} from '@/lib/courses-content'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { Star } from 'lucide-react'

import { FlagshipRow } from './flagship-row'

const MONO_LABEL =
	'font-mono text-[11px] font-medium uppercase tracking-wider opacity-60'

/**
 * /courses ("Learn with Matt") — v2 layout. Full-nav sales-adjacent page: NO
 * sidebar, NO breadcrumbs (Amy: "Courses will be landing pages").
 *
 * Surface logic (what makes groups readable):
 * - `bg-background` = editorial prose (hero, section intros).
 * - `bg-muted` = data about the offer (stat band, team strip, quotes,
 *   coming-next). The tint is what says "this belongs to the thing above".
 * - The painted brand stripe appears ONCE, under the hero — the page's single
 *   colorful moment (DESIGN rule 9), marking where the intro ends and the
 *   offer begins.
 * - The flagship offer is one welded slab: cohort row → stat band → facts
 *   grid → team strip, joined by hairlines with no padded gaps between them.
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
			{/* 1. Hero — editorial intro, closed by the painted brand stripe */}
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
				<div
					aria-hidden
					className="h-1.5 w-full bg-[url('/landing/colorful-stripe.jpg')] bg-contain bg-center bg-no-repeat sm:h-3"
				/>
			</section>

			{/* 2. Flagship cohort — intro prose, then the welded offer slab */}
			<section aria-labelledby="flagship-heading" className="border-b">
				<div className="flex flex-col gap-3 px-8 pb-12 pt-16 sm:px-16 md:pt-20">
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

				{/* The slab. Every block below shares hairlines with its neighbor —
				    no padded gaps — so row, stats, facts and team read as one unit. */}
				<FlagshipRow flagship={flagship} isPurchasable={isPurchasable} />

				{/* Stat band — live offer metadata, tinted */}
				<div
					className={
						alumniLabel
							? 'bg-border grid grid-cols-1 gap-px border-b sm:grid-cols-2'
							: 'bg-border grid grid-cols-1 gap-px border-b'
					}
				>
					{alumniLabel ? (
						<div className="bg-muted flex flex-col gap-1.5 px-8 py-6 sm:px-16">
							<p className={MONO_LABEL}>{FLAGSHIP_STATS.trainedLabel}</p>
							<p className="font-mono text-2xl font-semibold tracking-tight">
								{alumniLabel}
							</p>
							<p className="text-sm opacity-70">{FLAGSHIP_STATS.trainedSub}</p>
						</div>
					) : null}
					<div className="bg-muted flex flex-col gap-1.5 px-8 py-6 sm:px-16">
						<p className={MONO_LABEL}>{FLAGSHIP_STATS.enrollmentLabel}</p>
						<p className="font-mono text-2xl font-semibold tracking-tight">
							{isPurchasable
								? FLAGSHIP_STATS.openValue
								: FLAGSHIP_STATS.waitlistValue}
						</p>
						<p className="text-sm opacity-70">
							{isPurchasable
								? FLAGSHIP_STATS.openSub
								: FLAGSHIP_STATS.waitlistSub}
						</p>
					</div>
				</div>

				{/* Objection facts + team strip — same hairline grid, so the whole
				    thing stays one slab. Facts on background, team tinted to close
				    the unit the same way the stat band opened it. */}
				<div className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2">
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
					<div className="bg-muted flex flex-col gap-4 px-8 py-8 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between sm:px-16">
						<div className="flex flex-col gap-2">
							<h3 className="text-balance text-xl font-medium leading-tight tracking-tight sm:text-2xl">
								{FLAGSHIP_TEAM.heading}
							</h3>
							<p className="text-foreground/80 max-w-[60ch] text-base leading-relaxed">
								{FLAGSHIP_TEAM.body}
							</p>
						</div>
						<div className="shrink-0">
							<MoreWaysLink
								href={FLAGSHIP_TEAM.href}
								label={FLAGSHIP_TEAM.linkLabel}
							/>
						</div>
					</div>
				</div>
			</section>

			{/* 3. Real cohort-student testimonials — labeled, tinted pair */}
			<section aria-label="What cohort students say" className="border-b">
				<div className="px-8 pb-8 pt-12 sm:px-16">
					<p className={MONO_LABEL}>{COURSES_TESTIMONIALS_EYEBROW}</p>
				</div>
				<div className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2">
					{COURSES_TESTIMONIALS.map((testimonial) => (
						<figure
							key={testimonial.author}
							className="bg-muted flex flex-col gap-5 px-8 py-12 sm:px-16"
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
			<section className="border-b">
				<CompanyLogoGrid className="pt-6" />
			</section>

			{/* 5. Bookend — coming-next strip welded onto the waitlist capture:
			    the strip's promise ("the list hears first") IS the form below it */}
			<section
				id={COURSES_NEWSLETTER.anchorId}
				className="scroll-mt-24"
			>
				<div className="bg-muted border-b">
					<div className="flex flex-col gap-2 px-8 py-8 sm:px-16">
						<p className={MONO_LABEL}>{COURSES_COMING_NEXT.eyebrow}</p>
						<p className="text-foreground/80 max-w-[65ch] text-base leading-relaxed sm:text-lg">
							{COURSES_COMING_NEXT.body}
						</p>
					</div>
				</div>
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
