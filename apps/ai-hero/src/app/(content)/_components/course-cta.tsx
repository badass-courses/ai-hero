import { getNextOffer } from '@/lib/next-offer'

import { CourseCtaClient } from './course-cta-client'

export type CourseCtaProps = {
	/** The article this CTA renders under. Reserved for future per-post routing/analytics. */
	postId: string
	/** Editorial override: when true the CTA does not render. */
	suppress?: boolean
	className?: string
}

/**
 * Resolve the shared offer on the server. Reader-specific waitlist and
 * ownership checks happen in the client component so this static route does
 * not read the session or subscriber cookies.
 */
export async function CourseCta({
	suppress,
	className,
}: CourseCtaProps): Promise<JSX.Element | null> {
	if (suppress === true) return null

	const offer = await getNextOffer()
	if (!offer) return null

	return <CourseCtaClient offer={offer} className={className} />
}
