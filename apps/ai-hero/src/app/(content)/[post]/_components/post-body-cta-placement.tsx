import {
	OrganicOpportunityCta,
	organicOpportunityCtaBySlug,
} from '@/app/(content)/_components/organic-opportunity-cta'
import { SkillsCourseCta } from '@/app/(content)/skills/_components/skills-newsletter-cta'
import type { ResolvedPostCta } from '@/lib/post-cta'

export function PostBodyCtaPlacement({
	children,
	resolvedCta,
	slug,
}: {
	children: React.ReactNode
	resolvedCta: ResolvedPostCta
	slug: string
}) {
	const organicCtaKind = organicOpportunityCtaBySlug[slug]

	return (
		<>
			{children}
			{resolvedCta.kind === 'course' ? (
				<SkillsCourseCta
					headline={resolvedCta.copy.headline}
					subtitle={resolvedCta.copy.subtitle}
					source={`skill_page_course:${slug}`}
				/>
			) : null}
			{organicCtaKind ? (
				<OrganicOpportunityCta kind={organicCtaKind} />
			) : null}
		</>
	)
}
