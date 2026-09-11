import type { Metadata } from 'next'
import Link from 'next/link'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { HeroShader } from '@/components/landing/hero-shader'
import { BADGE_NEUTRAL, TYPE } from '@/components/landing/type'
import { PricingInline } from '@/components/pricing/pricing-inline'
import LayoutClient from '@/components/layout-client'
import { TeamInquiryForm } from '@/components/team-inquiry/team-inquiry-form'
import { AI_CODING_COHORT_SLUG } from '@/lib/campaign-landings'
import { AI_CODING_CRASH_COURSE_SLUG } from '@/lib/crash-course-purchaser-tag'
import { getCachedMinimalWorkshop } from '@/lib/workshops-query'
import {
	ArrowRight,
	ArrowUpRight,
	CalendarOff,
	Percent,
	PlayCircle,
	Receipt,
	User,
	Users,
} from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { WORKSHOP_CTA_BUTTON } from '../../(content)/workshops/_components/workshop-cta-button'
import { PublicWorkshopPricing } from '../../(content)/workshops/_components/workshop-public-pricing-server'

export const revalidate = 3600
export const dynamic = 'force-static'

const TITLE = 'AI Hero for your team'
const DESCRIPTION =
	'Team seats, bulk discounts, invoicing and procurement: all handled. Two ways to bring Matt Pocock’s AI coding training to your engineers.'

export const metadata: Metadata = {
	title: TITLE,
	description: DESCRIPTION,
	alternates: { canonical: '/for-your-team' },
	openGraph: { title: TITLE, description: DESCRIPTION },
}

/** The four facts a champion forwards to whoever signs off. */
const TEAM_FACTS = [
	{ icon: User, text: 'One licence per engineer, assigned from your account' },
	{ icon: Receipt, text: 'An invoice with your company details and tax ID' },
	{ icon: Percent, text: 'Volume pricing from five seats' },
	{ icon: CalendarOff, text: 'Self-paced, so nobody waits for a cohort date' },
] as const

/** The inner pad every band shares (DESIGN rules 1 and 3). */
const INNER = 'px-[18px] py-12 sm:px-11 md:py-[52px]'

const OFFER_LINK =
	'group mt-auto inline-flex items-center gap-2 text-foreground underline-offset-4 hover:underline'

/**
 * The generic teams hub. Linked from the `/courses` "Bringing your team?"
 * banner and the nav, and the address most inquiries already arrive from.
 *
 * It carries the two things we actually sell to a team today, in the order
 * they are sold: the self-paced crash course, which a champion can buy seats
 * for without talking to anyone, and recorded access to the completed cohort,
 * which is quoted per team. Both end at the same inquiry form, because that
 * is where every question we cannot answer on a page goes.
 */
export default async function TeamPage() {
	const crashCourse = await getCachedMinimalWorkshop(AI_CODING_CRASH_COURSE_SLUG)
	const crashCourseHref = crashCourse?.fields.forTeamsBody
		? `/workshops/${AI_CODING_CRASH_COURSE_SLUG}/for-teams`
		: `/workshops/${AI_CODING_CRASH_COURSE_SLUG}`

	return (
		<LayoutClient withContainer>
			<main className="flex min-h-screen w-full flex-col">
				{/* Hero: the claim on the left, and on the right the four facts a
				    champion forwards to whoever signs off, as a panel on the band
				    ground so it reads as an object the page hands you. Same stripes
				    ground the workshop hero wears. */}
				<header className="relative overflow-hidden border-b">
					<div className="relative z-10 grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
						<div className={cn('flex flex-col items-start', INNER)}>
							<span className={cn(TYPE.badge, BADGE_NEUTRAL, 'mb-5')}>
								For teams
							</span>
							<h1 className={cn(TYPE.title, 'max-w-[16ch] text-balance')}>
								{TITLE}
							</h1>
							<p
								className={cn(
									TYPE.lead,
									'text-foreground/80 mt-5 max-w-[58ch] text-balance',
								)}
							>
								Give your engineers a shared way to build with AI. Seats,
								invoicing and procurement are all handled, and you can start
								with a single seat if you need to convince your engineering
								director first.
							</p>
						</div>
						<div className="flex items-center px-[18px] pb-12 sm:px-11 md:border-l md:py-[52px]">
							<ul
								aria-label="What your team gets"
								className="border-input flex w-full flex-col rounded-[9px] border bg-[color:var(--ah-band)] px-5 py-4"
							>
								<li className={cn(TYPE.groupLabel, 'pb-3')}>
									What your team gets
								</li>
								{TEAM_FACTS.map(({ icon: Icon, text }) => (
									<li
										key={text}
										className={cn(
											TYPE.meta,
											'flex items-center gap-3 border-t border-[color:var(--ah-line-soft)] py-3 font-normal',
										)}
									>
										<span className="border-border bg-background flex size-9 shrink-0 items-center justify-center rounded-[6px] border text-[color:var(--ah-fg-muted)]">
											<Icon className="size-4" aria-hidden="true" />
										</span>
										{text}
									</li>
								))}
							</ul>
						</div>
					</div>
					{/* The page's one colourful moment (DESIGN § color strategy): the
					    brand shader the newsletter page wears, faded into the page
					    ground so the copy stays on neutral. */}
					<div
						aria-hidden
						className="pointer-events-none absolute inset-0 z-0 select-none overflow-hidden"
					>
						<HeroShader
							className="absolute inset-0 opacity-25"
							speed={0.2}
							frequency={7.0}
							displacement={0.018}
							displacementFreq={4.5}
							mouseFollow={0.03}
							mouseInfluence={0.55}
							flowY={0.2}
							flowX={0.2}
							intensity={1.0}
							saturation={1.25}
							sharpness={0.7}
							grain={0.1}
							grainTexture={0.3}
							grainScale={0.5}
							chromaOffset={13.0}
							vignette={0}
							mouseHalo={0.15}
							posterize={0.1}
							colorDrift={0.05}
							seed={10}
						/>
						{/* Two fades: down into the page ground, and from the copy column
						    outward so the words stay on neutral and the colour sits behind
						    the panel. */}
						<div className="bg-linear-to-b to-background absolute inset-0 from-transparent via-transparent" />
						<div className="from-background via-background/70 bg-linear-to-r absolute inset-0 to-transparent" />
					</div>
				</header>

				{/* The two offers, in a hairline grid (DESIGN rule 2). Each cell is
				    the same shape: what kind of thing, its name, what a team gets,
				    and the one way in. */}
				<section aria-label="Ways to bring AI Hero to your team" className="border-b">
					<div className="border-border bg-border grid grid-cols-1 gap-px md:grid-cols-2">
						<article
							className={cn('bg-background flex flex-col', INNER)}
							aria-labelledby="offer-crash-course"
						>
							<span className="border-border bg-background mb-5 flex size-11 items-center justify-center rounded-lg border text-[color:var(--ah-fg-muted)]">
								<PlayCircle className="size-5" aria-hidden="true" />
							</span>
							<div className="mb-4 flex flex-wrap items-center gap-3">
								<p className={cn(TYPE.groupLabel)}>01 / Self-paced course</p>
								<span className={cn(TYPE.badge, BADGE_NEUTRAL)}>Buy today</span>
							</div>
							<h2 id="offer-crash-course" className={cn(TYPE.heading)}>
								{crashCourse?.fields.title ?? 'AI Coding Crash Course'}
							</h2>
							{/* The live per-seat price, so the card answers the first
							    question a champion has before they click. Streams from the
							    same cached pricing the workshop page uses. */}
							<PublicWorkshopPricing moduleSlug={AI_CODING_CRASH_COURSE_SLUG}>
								{(pricing) =>
									pricing.allowPurchase ? (
										<p className={cn(TYPE.meta, 'text-muted-foreground mt-3')}>
											<span className={cn(TYPE.statSm, 'text-foreground')}>
												<PricingInline
													type="discounted"
													pricingDataLoader={pricing.pricingDataLoader}
												/>
											</span>{' '}
											per seat · volume pricing from five seats
										</p>
									) : null
								}
							</PublicWorkshopPricing>
							<p
								className={cn(
									TYPE.lead,
									'text-foreground/80 mt-4 max-w-[46ch]',
								)}
							>
								Buy a seat per engineer and assign them from your account.
								Everyone learns Matt’s AI Coding Loop on their own schedule,
								starting the moment you buy.
							</p>
							<div className="hidden md:block md:h-8" />
							{/* The page's one gold action: the path that needs nobody's reply. */}
							<Link
								href={crashCourseHref}
								className={cn(
									WORKSHOP_CTA_BUTTON,
									'group mt-8 inline-flex w-fit items-center gap-2 md:mt-auto',
								)}
							>
								See team options
								<ArrowUpRight
									className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
									aria-hidden="true"
								/>
							</Link>
						</article>
						<article
							className={cn('bg-background flex flex-col', INNER)}
							aria-labelledby="offer-cohort"
						>
							<span className="border-border bg-background mb-5 flex size-11 items-center justify-center rounded-lg border text-[color:var(--ah-fg-muted)]">
								<Users className="size-5" aria-hidden="true" />
							</span>
							<div className="mb-4 flex flex-wrap items-center gap-3">
								<p className={cn(TYPE.groupLabel)}>02 / Completed cohort</p>
								<span className={cn(TYPE.badge, BADGE_NEUTRAL)}>
									Quoted per team
								</span>
							</div>
							<h2 id="offer-cohort" className={cn(TYPE.heading)}>
								AI Coding for Real Engineers
							</h2>
							<p
								className={cn(
									TYPE.lead,
									'text-foreground/80 mt-4 max-w-[46ch]',
								)}
							>
								Team access to the completed cohort: the self-paced lessons and
								exercises, plus the recorded office hours from the live run.
								Specification-driven development, agent workflows and shared
								practices. Quoted per team.
							</p>
							<p className={cn(TYPE.metaSm, 'text-muted-foreground mb-8 mt-3')}>
								<Link
									href={`/cohorts/${AI_CODING_COHORT_SLUG}`}
									className="underline-offset-4 hover:underline"
								>
									What the cohort covered
								</Link>
							</p>
							<a href="#contact" className={cn(TYPE.meta, OFFER_LINK, 'h-[46px]')}>
								Get a quote for your team
								<ArrowRight
									className="ease-out-quart size-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none"
									aria-hidden="true"
								/>
							</a>
						</article>
					</div>
				</section>

				<section className="border-b">
					<CompanyLogoGrid className="pt-8" />
				</section>

				<section
					id="contact"
					aria-labelledby="contact-title"
					className="scroll-mt-(--nav-height)"
				>
					<div className="grid grid-cols-1 md:grid-cols-6">
						<div className={cn('col-span-3 lg:col-span-2', INNER)}>
							<p className={cn(TYPE.groupLabel, 'mb-4')}>Team pricing</p>
							<h2 id="contact-title" className={cn(TYPE.heading)}>
								Get a quote for your team
							</h2>
							<p
								className={cn(
									TYPE.lead,
									'text-foreground/80 mt-5 max-w-[40ch]',
								)}
							>
								Tell us how many engineers and what you want them to improve.
								You get pricing, an invoice your procurement team can use, and
								the fastest way to get everyone started. Volume pricing starts
								at five seats, and we reply within a working day.
							</p>
						</div>
						<div
							className={cn(
								'col-span-3 md:border-l lg:col-span-4',
								INNER,
								// Stacked under the copy on mobile, the two pads would double up.
								'pt-0 md:pt-[52px]',
							)}
						>
							<div>
								<TeamInquiryForm location="/for-your-team" />
							</div>
						</div>
					</div>
				</section>
			</main>
		</LayoutClient>
	)
}
