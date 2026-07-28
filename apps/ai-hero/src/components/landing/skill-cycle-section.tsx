import * as React from 'react'
import { getSkillEntries } from '@/lib/skills-query'
import { SkillCycle } from '@/components/skills/skill-cycle'

/**
 * Homepage wrapper around the W2 [[skill-cycle.tsx#SkillCycle]] diagram. The
 * diagram is a client component and cannot fetch, so this server component
 * supplies the CMS-owned entries and pins the homepage presentation:
 * `size="homepage"` (compact, no utility strip) and its OWN trailing CTA via
 * `ctaHref`, which is the seam the W4 wireframe calls "See all skills →".
 * Do NOT add a second link beside it.
 *
 * Renders nothing when the catalog is empty, so the homepage degrades to the
 * sections around it rather than showing an empty ring.
 */
export async function SkillCycleSection({
	ctaHref = '/skills',
	ctaLabel = 'See all skills',
}: {
	ctaHref?: string
	ctaLabel?: string
}) {
	const skills = await getSkillEntries()
	if (skills.length === 0) return null

	return (
		<section className="border-b px-8 py-12 sm:px-16 md:py-16">
			<SkillCycle
				skills={skills}
				size="homepage"
				ctaHref={ctaHref}
				ctaLabel={ctaLabel}
			/>
		</section>
	)
}
