import * as React from 'react'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { Hero } from '@/components/landing/hero'
import { ResourceRow } from '@/components/landing/resource-row'
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

import { TYPE } from '@/components/landing/type'

import { FlagshipRow } from './flagship-row'

import { cn } from '@coursebuilder/utils/cn'

/** The landing page's eyebrow, at the landing page's size (DESIGN rule 11). */
const MONO_LABEL = cn(TYPE.micro, 'opacity-60')

/**
 * "Heath, 15 years in industry" → name + role, so the attribution can be set
 * name-over-role like every other quote on the site.
 *
 * Comma, not the em dash `splitAttribution` looks for: these authors are
 * authored in `courses-content.ts` in that form, and rewriting the copy to
 * match a different splitter would be the tail wagging the dog.
 */
function splitCourseAttribution(author: string): {
	name: string
	role?: string
} {
	const [name, ...rest] = author.split(',')
	return {
		name: (name ?? author).trim(),
		role: rest.length > 0 ? rest.join(',').trim() : undefined,
	}
}

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
	comingNext,
}: {
	flagship: UpcomingCohortSummary | null
	isPurchasable: boolean
	/** e.g. "8,500+" — null hides the stat. */
	alumniLabel: string | null
	/** Crash-course pre-launch row; null (workshop missing) hides the section. */
	comingNext: { image?: string } | null
}) {
	return (
		<main className="bg-background text-foreground">
			{/* 1. Hero — the landing page's Hero component, not a lookalike.
			    Someone arriving here from the homepage should meet the same
			    masthead with different words, and sharing the component is the
			    only way that stays true after the next change to either page.

			    No painted stripe under it. On the landing page that stripe marks
			    the newsletter, the one full-bleed colour moment (DESIGN rule 9);
			    repeating it here as a plain section divider spent the same device
			    on "the intro ended", which the hairline already says.

			    The eyebrow is gone with it. "Courses" above an h1 reading "Learn
			    with Matt" on a page at /courses is the third time the reader is
			    told where they are. */}
			<Hero h1={COURSES_HERO.title} h2={COURSES_HERO.intro} />

			{/* 2. Flagship cohort — intro prose, then the welded offer slab */}
			<section aria-labelledby="flagship-heading" className="border-b">
				<div className="flex flex-col gap-3 px-8 pb-12 pt-16 sm:px-16 md:pt-20">
					<p className={MONO_LABEL}>{FLAGSHIP_SECTION.eyebrow}</p>
					<h2
						id="flagship-heading"
						className={cn(TYPE.heading, 'text-balance')}
					>
						{FLAGSHIP_SECTION.heading}
					</h2>
					<p className={cn(TYPE.body, 'text-foreground/80 max-w-[65ch]')}>
						{FLAGSHIP_SECTION.strapline}
					</p>
				</div>

				{/* The slab. Every block below shares hairlines with its neighbor —
				    no padded gaps — so row, stats, facts and team read as one unit. */}
				<FlagshipRow flagship={flagship} isPurchasable={isPurchasable} />

				{/* Offer metadata — one callout, not a hairline mosaic.

				    This was five bordered cells stacked straight under the cohort
				    row: two stats, two facts, one team strip, every one of them
				    boxed. Each border said "new section" and the reader got five of
				    those in a row, so the thing that is actually ONE offer arrived
				    looking like a dashboard of unrelated tiles.

				    The landing page's cohort block solved the same problem with a
				    single tinted callout (`UpcomingCohort`). Same move here: the
				    live numbers share one surface, the objection facts are plain
				    text in a column grid, and only the team strip keeps a surface of
				    its own — it is the one block that is a separate offer. */}
				<div className="flex flex-col gap-10 px-8 py-10 sm:px-16">
					<dl className="bg-muted flex w-fit flex-col gap-6 px-6 py-5 sm:flex-row sm:gap-12">
						{alumniLabel ? (
							<div className="flex flex-col gap-1">
								<dt className={MONO_LABEL}>{FLAGSHIP_STATS.trainedLabel}</dt>
								<dd className={cn(TYPE.subhead, 'font-mono tabular-nums')}>
									{alumniLabel}
								</dd>
								<dd className={cn(TYPE.metaProse, 'opacity-70')}>
									{FLAGSHIP_STATS.trainedSub}
								</dd>
							</div>
						) : null}
						<div className="flex flex-col gap-1">
							<dt className={MONO_LABEL}>{FLAGSHIP_STATS.enrollmentLabel}</dt>
							<dd className={cn(TYPE.subhead, 'font-mono')}>
								{isPurchasable
									? FLAGSHIP_STATS.openValue
									: FLAGSHIP_STATS.waitlistValue}
							</dd>
							<dd className={cn(TYPE.metaProse, 'opacity-70')}>
								{isPurchasable
									? FLAGSHIP_STATS.openSub
									: FLAGSHIP_STATS.waitlistSub}
							</dd>
						</div>
					</dl>

					{/* Objection facts. Whitespace separates them; they are four short
					    paragraphs, and boxing each one made the reader parse a grid
					    before parsing a sentence. */}
					<div className="grid grid-cols-1 gap-x-12 gap-y-8 sm:grid-cols-2">
						{FLAGSHIP_FACTS.map((fact) => (
							<div key={fact.label} className="flex flex-col gap-2">
								<h3 className={MONO_LABEL}>{fact.label}</h3>
								<p className={cn(TYPE.body, 'text-foreground/80 max-w-[55ch]')}>
									{fact.body}
								</p>
							</div>
						))}
					</div>
				</div>

				{/* Team strip — the one block here that IS a separate offer, so it
				    keeps its own surface and its own rule. */}
				<div className="bg-muted border-border flex flex-col gap-4 border-t px-8 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-16">
					<div className="flex flex-col gap-2">
						<h3 className={cn(TYPE.subhead, 'text-balance')}>
							{FLAGSHIP_TEAM.heading}
						</h3>
						<p className={cn(TYPE.body, 'text-foreground/80 max-w-[60ch]')}>
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
			</section>

			{/* 3. Cohort-student testimonials.

			    Typographically these are now the same voice as the landing page's
			    quotes (`DraftTestimonial` / `TestimonialDivider`): italic at
			    subhead, gold stars, name over role. They were upright `font-medium`
			    inside tinted boxes, which read as feature cards that happened to
			    contain speech — and the site already has a settled way of showing
			    that a person said something.

			    The tint and the hairline between them are gone for the same reason
			    the metadata's went: two quotes side by side are two quotes, and
			    boxing them made them look like a comparison table. */}
			<section aria-label="What cohort students say" className="border-b">
				<div className="px-8 pb-8 pt-12 sm:px-16">
					<p className={MONO_LABEL}>{COURSES_TESTIMONIALS_EYEBROW}</p>
				</div>
				<div className="grid grid-cols-1 gap-10 px-8 pb-14 sm:grid-cols-2 sm:gap-12 sm:px-16">
					{COURSES_TESTIMONIALS.map((testimonial) => {
						const { name, role } = splitCourseAttribution(testimonial.author)
						return (
							<figure
								key={testimonial.author}
								className="flex flex-col items-start gap-5"
							>
								<div
									aria-hidden
									className="flex items-center gap-1 text-[#ffcf77]"
								>
									{Array.from({ length: 5 }).map((_, index) => (
										<Star key={index} className="size-4 fill-[#ffcf77]" />
									))}
								</div>
								<blockquote
									className={cn(TYPE.subhead, 'text-balance font-sans italic')}
								>
									&ldquo;{testimonial.quote}&rdquo;
								</blockquote>
								<figcaption className="flex flex-col leading-tight">
									<span className={cn(TYPE.meta, 'text-foreground font-semibold')}>
										{name}
									</span>
									{role ? (
										<span className={cn(TYPE.metaProse, 'text-muted-foreground')}>
											{role}
										</span>
									) : null}
								</figcaption>
							</figure>
						)
					})}
				</div>
			</section>

			{/* 4. Trusted by (full-bleed, same usage as /skills) */}
			<section className="border-b">
				<CompanyLogoGrid className="pt-6" />
			</section>

			{/* 5. Coming next — the crash course's pre-launch page is a public
			    interest-capture with its own waitlist form, so this is a real
			    click-through row, not an announcement. Row supplies the bottom
			    hairline (its own border-y), so the section carries no border-b. */}
			{comingNext ? (
				<section aria-label={COURSES_COMING_NEXT.title}>
					<div className="px-8 pb-8 pt-12 sm:px-16">
						<p className={MONO_LABEL}>{COURSES_COMING_NEXT.eyebrow}</p>
					</div>
					<ResourceRow
						title={COURSES_COMING_NEXT.title}
						description={COURSES_COMING_NEXT.description}
						href={`/workshops/${COURSES_COMING_NEXT.slug}`}
						image={comingNext.image}
						typeLabel={COURSES_COMING_NEXT.typeLabel}
						badge={COURSES_COMING_NEXT.badge}
						fallbackPlaceholder="Course"
					/>
				</section>
			) : null}

			{/* 6. Newsletter bookend — the general capture */}
			<section
				id={COURSES_NEWSLETTER.anchorId}
				className="scroll-mt-24"
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
