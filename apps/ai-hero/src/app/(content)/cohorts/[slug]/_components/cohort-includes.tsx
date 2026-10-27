import * as React from 'react'
import {
	ProductPricingFeatures,
	type ProductPricingFeature,
} from '@/components/commerce/product-pricing-features'
import { PlayCircle } from 'lucide-react'

export type CohortWorkshopRef = { title: string; slug: string }

/**
 * The cohort's lesson total as a row of the feature list, placed by the list
 * directly under its workshop count. Empty when there is nothing to count, so
 * a cohort whose trees are empty (or could not be read) shows no "0 Lessons".
 */
export function cohortLessonFeatures(
	lessonCount: number,
): ProductPricingFeature[] {
	if (lessonCount <= 0) return []
	return [
		{
			icon: <PlayCircle className="h-4 w-4" />,
			label: `${lessonCount} ${lessonCount === 1 ? 'Lesson' : 'Lessons'}`,
		},
	]
}

/**
 * What every seat comes with, for the rail states that have no pricing card:
 * the waitlist and the purchased rail. Someone weighing the cohort and someone
 * already enrolled both want the same answer to "what do I actually get".
 *
 * It is the pricing card's own checklist, not a second design. When seats are
 * on sale the card renders that checklist itself (between the guarantee and
 * the boss letter, as on a workshop page), so the rail must show one or the
 * other and never both: two "Includes" stacked in one column read as a
 * mistake.
 *
 * @param lessonCount - Lessons across every workshop; 0 drops the row.
 */
export const CohortIncludes: React.FC<{
	workshops: CohortWorkshopRef[]
	lessonCount: number
	className?: string
}> = ({ workshops, lessonCount, className }) => (
	<ProductPricingFeatures
		variant="checklist"
		productType="cohort"
		workshops={workshops}
		prependFeatures={cohortLessonFeatures(lessonCount)}
		className={className}
	/>
)
