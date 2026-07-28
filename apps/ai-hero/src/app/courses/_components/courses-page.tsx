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
	FLAGSHIP_STATS,
	FLAGSHIP_TEAM,
} from '@/lib/courses-content'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { Star } from 'lucide-react'

import { TYPE } from '@/components/landing/type'

import { FlagshipOffer } from './flagship-offer'

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
 * The page is ordered as one argument, and the order IS the hierarchy:
 *
 *   1. Hero            — what this page is.
 *   2. The offer       — the flagship, as the page's dominant block.
 *   3. Objection facts — supporting detail for it.
 *   4. Proof           — alumni count, then quotes, then logos, uninterrupted.
 *   5. Team seats      — a different buyer, after the individual sale.
 *   6. Coming next     — genuinely secondary, so a listing row is correct here.
 *   7. Newsletter      — the fallback ask for everyone who did not convert.
 *
 * What this replaced: the flagship rendered through `ResourceRow`, the same
 * listing component as the not-yet-released crash course, so the one thing
 * this page sells had the same weight as a course that does not exist. Around
 * it, evidence was scattered across three places on both sides of a team
 * upsell, and the offer's own metadata sat in bordered bands below it.
 *
 * Surfaces carry one meaning each: `bg-background` is editorial, `bg-muted` is
 * an offer you can act on (the flagship block, team seats). Nothing else is
 * tinted — a tint that appears everywhere stops saying anything.
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

			{/* 2. THE offer. One dominant block — see flagship-offer.tsx for why
			    this stopped being a ResourceRow. */}
			<FlagshipOffer flagship={flagship} isPurchasable={isPurchasable} />

			{/* 3. The objection answers. Supporting detail for the block above, so
			    plain text on the page surface — no boxes. Four short paragraphs
			    boxed in a hairline grid made the reader parse a table before
			    parsing a sentence. */}
			<section aria-label="What the cohort asks of you" className="border-b">
				<div className="grid grid-cols-1 gap-x-12 gap-y-8 px-8 py-14 sm:grid-cols-2 sm:px-16">
					{FLAGSHIP_FACTS.map((fact) => (
						<div key={fact.label} className="flex flex-col gap-2">
							<h3 className={MONO_LABEL}>{fact.label}</h3>
							<p className={cn(TYPE.body, 'text-foreground/80 max-w-[55ch]')}>
								{fact.body}
							</p>
						</div>
					))}
				</div>
			</section>

			{/* 4. Proof, in one continuous run: the number, then the people, then
			    the logos.

			    These were three separate pieces of evidence in three unrelated
			    places — the alumni count in a stat band above the objection facts,
			    the quotes below a team upsell, the logos below those. Evidence
			    compounds when it is read together and does nothing when it is
			    scattered, so it is now one section that opens on the count.

			    The team upsell used to sit in the middle of this run. It addresses
			    a different buyer entirely and it interrupted the path from "here
			    is the offer" to "here is why you should believe it", so it moved
			    below — after the individual sale has been made. */}
			{alumniLabel ? (
				<section aria-label="Cohort alumni" className="border-b">
					<div className="flex flex-col gap-1 px-8 py-12 sm:px-16">
					{/* Sans, not mono. `tabular-nums` gives the comma a full digit
						    cell, so "8,500+" set in Geist Mono renders as "8 , 500+".
						    Tabular figures are for columns that have to line up; this
						    is a display number read once. */}
						<p className={cn(TYPE.display, 'font-sans')}>{alumniLabel}</p>
						<p className={cn(TYPE.subhead, 'font-normal opacity-80')}>
							{FLAGSHIP_STATS.trainedLabel.toLowerCase()},{' '}
							{FLAGSHIP_STATS.trainedSub.toLowerCase()}
						</p>
					</div>
				</section>
			) : null}

			{/* Cohort-student testimonials.

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

			{/* Trusted by — closes the proof run (full-bleed, same usage as /skills) */}
			<section className="border-b">
				<CompanyLogoGrid className="pt-6" />
			</section>

			{/* 5. Team seats. A different buyer, addressed after the individual
			    sale — it used to interrupt the offer-to-proof path. */}
			<section
				aria-label={FLAGSHIP_TEAM.heading}
				className="bg-muted border-border flex flex-col gap-4 border-b px-8 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-16"
			>
				<div className="flex flex-col gap-2">
					<h2 className={cn(TYPE.subhead, 'text-balance')}>
						{FLAGSHIP_TEAM.heading}
					</h2>
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
