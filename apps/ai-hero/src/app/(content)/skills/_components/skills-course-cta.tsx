import {
	SkillsCourseCta as SubscriberAwareSkillsCourseCta,
	type SkillsNewsletterCtaState,
} from './skills-newsletter-cta'

/**
 * Course offer used at the end of an individual AI Skills changelog entry.
 *
 * Keep the changelog-specific copy here, but let the shared course CTA decide
 * whether this reader needs the signup form, a one-click enrolment button, or
 * the compact lesson-one recovery bar.
 */
export function SkillsCourseCta({
	forceState,
}: {
	forceState?: SkillsNewsletterCtaState
}) {
	return (
		<SubscriberAwareSkillsCourseCta
			headline="AI Skills for Real Engineers"
			subtitle="Build a repeatable workflow for coding agents without giving up your engineering standards."
			source="skill_changelog_course"
			forceState={forceState}
		/>
	)
}
