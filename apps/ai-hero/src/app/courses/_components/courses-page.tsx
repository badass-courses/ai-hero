import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { TYPE } from '@/components/landing/type'
import {
	COURSES_CATALOG,
	COURSES_COMING_NEXT,
	COURSES_DETAILS_EYEBROW,
	COURSES_TESTIMONIALS,
	COURSES_TESTIMONIALS_EYEBROW,
	FLAGSHIP_FACTS,
	FLAGSHIP_TEAM,
} from '@/lib/courses-content'
import type { UpcomingCohortSummary } from '@/lib/upcoming-cohort-query'
import { ArrowRight, Star } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { FlagshipHero } from './flagship-hero'

/** The landing page's eyebrow, at the landing page's size (DESIGN rule 11). */
const MONO_LABEL = cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')

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
 * /courses ("Learn with Matt") — the redesign's direction `1a`, the "spec
 * sheet". Full-nav sales-adjacent page: NO sidebar, NO breadcrumbs (Amy:
 * "Courses will be landing pages").
 *
 * The page is one argument and the order IS the hierarchy:
 *
 *   1. The flagship, AS the hero — pitch left, the ask right, one hairline
 *      between them. It is not introduced; it is the page.
 *   2. What you're signing up for — the practical detail, as a 4-up hairline
 *      grid you scan rather than four paragraphs you read.
 *   3. Team seats — a different buyer, welded to the details because that is
 *      where the question ("can I expense this?") actually arrives.
 *   4. Proof — quotes, then logos, uninterrupted.
 *   5. Everything else — the self-paced catalog.
 *
 * What this replaced, and why the previous ordering is gone:
 *
 * - **The masthead.** The page opened on "Learn with Matt" and put the offer
 *   in the block below it: two headlines and two asks before a reader who
 *   came here to buy one thing had read anything. The flagship's slogan is
 *   now the `h1` and the site's name for itself is not a headline.
 * - **The alumni count as its own band.** "8,500+" spent a full-bleed section
 *   on one number, below the offer it was evidence for. It is now the first
 *   fact in the hero's fact row, where it is read while the claim is still on
 *   screen.
 * - **"Coming next".** A course that does not exist yet had a section to
 *   itself, above the fold of that section, while the two courses you can
 *   start today were nowhere on the page. All three are now cells in the
 *   catalog grid, each badged with its honest status.
 * - **The bookend newsletter.** It was the same Kit form making the same ask
 *   as the hero's waitlist, 3000px later. The hero carries the `#join`
 *   anchor now, so every link that pointed at the bookend still lands.
 *
 * Surfaces carry one meaning each: `bg-background` is editorial, `bg-muted`
 * is an ask you can act on (the waitlist rail, team seats). Nothing else is
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
	/** Crash-course cover art; null (workshop missing) drops the card. */
	comingNext: { image?: string } | null
}) {
	// The crash course leads the catalog when it exists: it is the closest
	// thing to the cohort, and the waitlist it feeds is the same ask the hero
	// makes. Missing workshop means missing card, never an empty cell.
	const catalog = [
		...(comingNext
			? [
					{
						title: COURSES_COMING_NEXT.title,
						href: `/workshops/${COURSES_COMING_NEXT.slug}`,
						description: COURSES_COMING_NEXT.description,
						badge: COURSES_COMING_NEXT.badge,
						badgeTone: 'accent' as const,
						image: comingNext.image,
					},
				]
			: []),
		...COURSES_CATALOG.items,
	]

	return (
		<main className="bg-background text-foreground">
			{/* 1. The flagship IS the hero. See flagship-hero.tsx. */}
			<FlagshipHero
				flagship={flagship}
				isPurchasable={isPurchasable}
				alumniLabel={alumniLabel}
			/>

			{/* 2 + 3. The practical detail, then the team ask.
			    Four short answers in a hairline grid rather than four
			    paragraphs: these are the questions a buyer arrives with
			    already formed, so they should be scannable, not readable.
			    The grid is inset, so it takes the panel radius — it is an
			    object on the page rather than the page's own structure
			    (DESIGN rule 12). */}
			<section aria-label={COURSES_DETAILS_EYEBROW} className="border-b">
				<div className="flex flex-col gap-4 px-8 py-16 sm:px-11 md:py-20">
					<div className="flex flex-col gap-6">
						<p className={MONO_LABEL}>{COURSES_DETAILS_EYEBROW}</p>
						<div className="border-border bg-border grid grid-cols-1 gap-px overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
							{FLAGSHIP_FACTS.map((fact) => (
								<div
									key={fact.label}
									className="bg-background flex flex-col gap-2.5 p-6"
								>
									<h3 className={cn(TYPE.micro, 'text-primary')}>
										{fact.label}
									</h3>
									<p
										className={cn(
											TYPE.metaProse,
											'text-[color:var(--ah-fg-muted)]',
										)}
									>
										{fact.body}
									</p>
								</div>
							))}
						</div>
					</div>

					{/* Team seats sits under the details, not between the offer and
					    its proof, where it used to interrupt the one path this
					    page has. Outline button: the hero already spent the
					    viewport's one gold fill. */}
					<div className="border-border bg-muted flex flex-col gap-5 rounded-lg border p-6 sm:flex-row sm:items-center sm:gap-8">
						<div className="flex min-w-0 flex-col gap-1.5">
							<h2 className={TYPE.cardTitle}>{FLAGSHIP_TEAM.heading}</h2>
							<p
								className={cn(
									TYPE.metaProse,
									'max-w-[70ch] text-[color:var(--ah-fg-muted)]',
								)}
							>
								{FLAGSHIP_TEAM.body}
							</p>
						</div>
						<Link
							href={FLAGSHIP_TEAM.href}
							className={cn(
								TYPE.meta,
								'border-foreground/20 hover:bg-secondary focus-visible:ring-ring group inline-flex h-11 shrink-0 items-center gap-2 rounded-[9px] border px-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:ml-auto',
							)}
						>
							{FLAGSHIP_TEAM.linkLabel}
							<ArrowRight
								aria-hidden
								className="ease-out-quart size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
							/>
						</Link>
					</div>
				</div>
			</section>

			{/* 4. Proof, in one run: the people, then the logos.
			    Typographically these are the same voice as the landing page's
			    quotes: italic at subhead, gold stars, name over role. Six of
			    them in a 2-up hairline grid — two quotes read as the only two
			    that exist. */}
			<section aria-label={COURSES_TESTIMONIALS_EYEBROW} className="border-b">
				<div className="px-8 pb-6 pt-12 sm:px-11">
					<p className={MONO_LABEL}>{COURSES_TESTIMONIALS_EYEBROW}</p>
				</div>
				<div className="border-border bg-border grid grid-cols-1 gap-px border-t md:grid-cols-2">
					{COURSES_TESTIMONIALS.map((testimonial) => {
						const { name, role } = splitCourseAttribution(testimonial.author)
						return (
							<figure
								key={testimonial.author}
								className="bg-background flex flex-col items-start gap-5 p-8 sm:p-10 lg:px-16 lg:py-12"
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
								<figcaption className="mt-auto flex flex-col leading-tight">
									<span className={cn(TYPE.meta, 'text-foreground')}>
										{name}
									</span>
									{role ? (
										<span
											className={cn(
												TYPE.metaProse,
												'text-[color:var(--ah-fg-subtle)]',
											)}
										>
											{role}
										</span>
									) : null}
								</figcaption>
							</figure>
						)
					})}
				</div>
			</section>

			{/* Trusted by — closes the proof run (full-bleed, same usage as
			    /skills). The design draws this as a single row with a leading
			    label; `CompanyLogoGrid` is the shared component that owns the
			    real wordmarks, and its own hairline grid is the honest trade:
			    twelve real logos beat one row of placeholder text. */}
			<section className="border-b">
				<CompanyLogoGrid className="pt-8" />
			</section>

			{/* 5. Everything else Matt teaches. Cards float on the page surface,
			    so they take the card radius; the section itself does not. */}
			<section aria-label={COURSES_CATALOG.eyebrow}>
				<div className="px-8 py-16 sm:px-11 md:py-20">
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
						<p className={MONO_LABEL}>{COURSES_CATALOG.eyebrow}</p>
						<p
							className={cn(
								TYPE.command,
								'font-normal text-[color:var(--ah-fg-faint)]',
							)}
						>
							{COURSES_CATALOG.note}
						</p>
					</div>
					<div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))]">
						{catalog.map((item) => (
							<CatalogCard key={item.href} {...item} />
						))}
					</div>
				</div>
			</section>
		</main>
	)
}

function CatalogCard({
	title,
	href,
	description,
	badge,
	badgeTone,
	image,
}: {
	title: string
	href: string
	description: string
	badge: string
	badgeTone: 'accent' | 'neutral'
	image?: string
}) {
	return (
		<Link
			href={href}
			className="border-border bg-card hover:border-foreground/20 focus-visible:ring-ring group flex flex-col overflow-hidden rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
		>
			<div
				className={cn(
					'border-border relative aspect-video w-full overflow-hidden border-b',
					image ? 'bg-muted' : 'bg-stripes',
				)}
			>
				{image ? (
					<Image
						src={image}
						alt=""
						fill
						sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
						className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02] motion-reduce:transform-none motion-reduce:transition-none"
					/>
				) : null}
			</div>
			<div className="flex flex-col items-start gap-2.5 p-5">
				<span
					className={cn(
						TYPE.micro,
						'inline-flex items-center rounded-[4px] border px-2 py-1',
						badgeTone === 'accent'
							? 'text-primary border-[color:var(--ah-accent-line)]'
							: 'border-border text-[color:var(--ah-fg-muted)]',
					)}
				>
					{badge}
				</span>
				<h3 className={TYPE.cardTitle}>{title}</h3>
				<p className={cn(TYPE.metaProse, 'text-[color:var(--ah-fg-muted)]')}>
					{description}
				</p>
			</div>
		</Link>
	)
}
