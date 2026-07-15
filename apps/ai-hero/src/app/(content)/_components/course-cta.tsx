import Link from 'next/link'
import { getLatestCohort, getUpcomingCohort } from '@/lib/upcoming-cohort-query'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { cn } from '@coursebuilder/utils/cn'
import { ArrowRight } from 'lucide-react'

export type CourseCtaProps = {
	/** The article this CTA renders under. Reserved for future per-post routing/analytics. */
	postId: string
	/** Editorial override: when true the CTA does not render. */
	suppress?: boolean
	className?: string
}

/**
 * High-weight, bottom-of-article course CTA. Renders on every eligible article
 * by default (unless `suppress`), pulling the actual next purchasable cohort via
 * the shared {@link getUpcomingCohort} selector rather than hand-authored copy.
 *
 * - Active cohort → cohort title + "next cohort starts {date}" + "Learn more →"
 *   linking to `/cohorts/{slug}`.
 * - No purchasable cohort (between cohorts) → waitlist state, same shell, CTA
 *   links to the LATEST cohort's own page (the /cohorts index is unused —
 *   Vojta, 2026-07-14).
 *
 * Generalizes `OrganicOpportunityCta`'s slug-gated hardcoded map; shares its
 * shell treatment (`border-primary/30 bg-primary/5`) as the high-weight baseline,
 * squared per DESIGN.md rule 12.
 */
export async function CourseCta({
	suppress,
	className,
}: CourseCtaProps): Promise<JSX.Element | null> {
	if (suppress === true) return null

	const cohort = await getUpcomingCohort()
	const latest = cohort ? null : await getLatestCohort()
	const target = cohort ?? latest
	if (!target) return null

	const eyebrow = 'Ready to go deeper?'

	const title = target.title

	const startsLabel = cohort?.startsAt
		? formatCohortDateRange(cohort.startsAt, null).dateString
		: null

	const description = cohort
		? startsLabel
			? `Next cohort starts ${startsLabel}.`
			: 'Join the next cohort and build these habits alongside other engineers.'
		: 'Enrollment is closed between cohorts. Join the waitlist to hear when the next one opens.'

	const href = `/cohorts/${target.slug}`

	const label = cohort ? 'Learn more' : 'Join the waitlist'

	return (
		<aside
			className={cn(
				'not-prose border-primary/30 bg-primary/5 my-12 flex flex-col gap-4 border p-6 sm:p-8',
				className,
			)}
		>
			<div className="flex flex-col gap-2">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
					{eyebrow}
				</span>
				<h2 className="text-foreground text-balance text-2xl font-semibold leading-tight tracking-tight">
					{title}
				</h2>
				<p className="text-foreground/80 text-balance text-base leading-relaxed">
					{description}
				</p>
			</div>
			<div>
				<Link
					href={href}
					className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring focus-visible:ring-offset-background group inline-flex h-11 items-center gap-2 px-5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					{label}
					<ArrowRight
						className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
						aria-hidden="true"
					/>
				</Link>
			</div>
		</aside>
	)
}
