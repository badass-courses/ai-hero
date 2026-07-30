import {
	OrganicOpportunityCta,
	organicOpportunityCtaBySlug,
} from '@/app/(content)/_components/organic-opportunity-cta'
import { SkillsCourseCta } from '@/app/(content)/skills/_components/skills-newsletter-cta'
import type { ResolvedPostCta } from '@/lib/post-cta'

/**
 * Everything that may appear directly under an article body, and the order of
 * precedence between them.
 *
 * Three separate features want this one slot, and they arrived independently:
 * the email-course ask (`cta` field / `postType: 'skill'`), the slug-gated
 * `OrganicOpportunityCta` map, and the redesign's cohort `CourseCta`. Each was
 * written as if it were the only one, so the precedence has to be stated
 * somewhere; it is stated here, and nowhere else, because a page that asks for
 * two things at once converts on neither.
 *
 * The order:
 *
 * 1. The email course, when the post declares it. This is the cheapest ask on
 *    the page and the one our search traffic actually takes — these are people
 *    who typed the name of a skill they already have, not people shopping for a
 *    cohort.
 * 2. `OrganicOpportunityCta` for the slugs that map to one. Rendered alongside
 *    the course ask rather than instead of it, which is how it shipped and how
 *    it behaves in production today; deliberately not changed here.
 * 3. The cohort CTA, only if neither of the above claimed the slot. It is the
 *    most expensive ask we make, so it goes last and yields to the others.
 *
 * `cohortCta` arrives as an element rather than a flag because `CourseCta` is an
 * async server component that queries cohorts. Passing it unrendered means that
 * query only runs when this component actually decides to render it.
 */
export function PostBodyCtaPlacement({
	children,
	resolvedCta,
	slug,
	cohortCta = null,
}: {
	children: React.ReactNode
	resolvedCta: ResolvedPostCta
	slug: string
	/** The cohort ask, or `null` when this post shape is not eligible for one. */
	cohortCta?: React.ReactNode
}) {
	const organicCtaKind = organicOpportunityCtaBySlug[slug]
	const hasCourseCta = resolvedCta.kind === 'course'

	return (
		<>
			{children}
			{hasCourseCta ? (
				<SkillsCourseCta
					headline={resolvedCta.copy.headline}
					subtitle={resolvedCta.copy.subtitle}
					source={`skill_page_course:${slug}`}
				/>
			) : null}
			{organicCtaKind ? (
				<OrganicOpportunityCta kind={organicCtaKind} />
			) : null}
			{!hasCourseCta && !organicCtaKind ? cohortCta : null}
		</>
	)
}
