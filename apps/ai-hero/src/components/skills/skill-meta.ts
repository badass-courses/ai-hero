/**
 * Pure, client-safe derivations for a skill post's identity: the slash command
 * it is invoked as, the one-skill install line, and where its source lives.
 *
 * These are DERIVED, not CMS fields. A skill post's body already prints the
 * same `npx skills add … --skill=<name>` line (GitHub-synced from SKILL.md), so
 * building it from the slug keeps the head panel and the body in agreement
 * without a new content field to forget to fill in.
 */

import { SKILLS_HERO, SKILLS_REPO_URL } from '@/lib/skills-content'
import { type SkillEntry } from '@/lib/skills-shared'

/** `skills-grill-me` → `grill-me`. Skill posts live at flat root slugs. */
export function invocationName(slug: string): string {
	return slug.replace(/^skills-/, '')
}

/** The install line for one skill, e.g. `npx skills add owner/repo --skill=grill-me -y -g`. */
export function skillInstallCommand(slug: string): string {
	return `npx skills add ${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName} --skill=${invocationName(slug)} -y -g`
}

/** The whole-set install line, shared with the /skills landing hero. */
export const SKILLS_INSTALL_ALL_COMMAND = SKILLS_HERO.installCommand

/** Repo the skills are published from, as shown in the head panel's Source cell. */
export const SKILL_SOURCE = {
	label: `${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName}`,
	href: SKILLS_REPO_URL,
} as const

export type SkillNeighbors = {
	current: SkillEntry
	prev: SkillEntry
	next: SkillEntry
} | null

/**
 * Cycle neighbours for a slug, wrapping around the ring (last → first). Returns
 * null when the post is not a list member or the list has fewer than two
 * entries: a fabricated "next" is worse than no pager.
 */
export function getSkillNeighbors(
	entries: SkillEntry[],
	slug: string,
): SkillNeighbors {
	const index = entries.findIndex((entry) => entry.slug === slug)
	if (index === -1 || entries.length < 2) return null

	const total = entries.length
	const current = entries[index]
	const prev = entries[(index - 1 + total) % total]
	const next = entries[(index + 1) % total]
	if (!current || !prev || !next) return null

	return { current, prev, next }
}
