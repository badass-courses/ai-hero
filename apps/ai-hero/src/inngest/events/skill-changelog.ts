export const SKILL_CHANGELOG_PUBLISHED_EVENT =
	'skill-changelog/published' as const

export type SkillChangelogPublished = {
	name: typeof SKILL_CHANGELOG_PUBLISHED_EVENT
	data: {
		resourceId: string
		slug: string
	}
}
