import type { Metadata } from 'next'
import Link from 'next/link'
import { BADGE_NEUTRAL, TYPE } from '@/components/landing/type'
import LayoutClient from '@/components/layout-client'
import { TeamInquiryForm } from '@/components/team-inquiry/team-inquiry-form'
import { AI_CODING_COHORT_SLUG } from '@/lib/campaign-landings'
import { AI_CODING_CRASH_COURSE_SLUG } from '@/lib/crash-course-purchaser-tag'
import { getCachedMinimalWorkshop } from '@/lib/workshops-query'
import { ArrowRight, ArrowUpRight } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { WORKSHOP_CTA_BUTTON } from '../../(content)/workshops/_components/workshop-cta-button'

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
				<header className="border-b">
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
							<p className={cn(TYPE.groupLabel, 'mb-4')}>
								01 / Self-paced course
							</p>
							<h2 id="offer-crash-course" className={cn(TYPE.heading)}>
								{crashCourse?.fields.title ?? 'AI Coding Crash Course'}
							</h2>
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
							<p className={cn(TYPE.groupLabel, 'mb-4')}>
								02 / Completed cohort
							</p>
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
								Ask about team access
								<ArrowRight
									className="ease-out-quart size-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none"
									aria-hidden="true"
								/>
							</a>
						</article>
					</div>
				</section>

				<section
					id="contact"
					aria-labelledby="contact-title"
					className="scroll-mt-(--nav-height) border-b"
				>
					<div className="grid grid-cols-1 md:grid-cols-6">
						<div className={cn('col-span-3 lg:col-span-2', INNER)}>
							<p className={cn(TYPE.groupLabel, 'mb-4')}>Talk to us</p>
							<h2 id="contact-title" className={cn(TYPE.heading)}>
								Tell us about your team
							</h2>
							<p
								className={cn(
									TYPE.lead,
									'text-foreground/80 mt-5 max-w-[40ch]',
								)}
							>
								Team size, what you want your engineers to improve, and
								anything procurement needs from us. We reply within a working
								day.
							</p>
						</div>
						<div className={cn('col-span-3 md:border-l lg:col-span-4', INNER)}>
							<div className="max-w-2xl">
								<TeamInquiryForm location="/for-your-team" />
							</div>
						</div>
					</div>
				</section>
			</main>
		</LayoutClient>
	)
}
