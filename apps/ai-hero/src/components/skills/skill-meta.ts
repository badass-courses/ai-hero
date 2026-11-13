/**
 * Pure, client-safe derivations for a skill post's identity: the slash command
 * it is invoked as, the one-skill install line, and where its source lives.
 *
 * These are DERIVED, not CMS fields. A skill post's body already prints the
 * same `npx skills@latest add … --skill=<name>` line (GitHub-synced from
 * SKILL.md), so building it from the slug keeps the head panel and the body in
 * agreement without a new content field to forget to fill in.
 */

import {
	SKILLS_HERO,
	SKILLS_PORTABLE_INSTALL_COMMAND,
	SKILLS_REPO_URL,
} from '@/lib/skills-content'
import { type SkillEntry } from '@/lib/skills-shared'

/** `skills-grill-me` → `grill-me`. Skill posts live at flat root slugs. */
export function invocationName(slug: string): string {
	return slug.replace(/^skills-/, '')
}

/**
 * The sibling skills a SKILL.md says it invokes, in first-mention order.
 *
 * Skills hand off to each other by name ("Call the Skill tool with
 * `codebase-design`", "call the Skill tool twice, for \"grilling\" and
 * \"domain-modeling\""). Installing one without the skills it calls leaves it
 * broken, so the install line has to carry them. Reading the names from the
 * synced body keeps that list in step with the repo, with no hand-kept map.
 *
 * Only quoted or backticked names in the same sentence as "Skill tool" count,
 * and only shell-safe kebab-case names: a stray word must never reach a
 * `--skill=` flag. One level deep: the page has its own body, not its callees'.
 */
export function skillDependencies(
	body: string | null | undefined,
	slug: string,
): string[] {
	if (!body) return []
	const self = invocationName(slug)
	const found: string[] = []
	for (const mention of body.matchAll(/Skill tool\b([^\n]{0,160})/gi)) {
		const clause = (mention[1] ?? '').split(/(?<=[.;:])\s|\)\s/)[0] ?? ''
		for (const name of clause.matchAll(/["`]([a-z0-9][a-z0-9-]{0,63})["`]/g)) {
			const skill = name[1]
			if (skill && skill !== self && !found.includes(skill)) found.push(skill)
		}
	}
	return found
}

/**
 * The editable install line for one skill, e.g. `npx skills@latest add owner/repo --skill=grill-me`,
 * plus one `--skill=` per sibling skill it calls (see `skillDependencies`).
 */
export function skillInstallCommand(
	slug: string,
	dependsOn: readonly string[] = [],
): string {
	const skills = [invocationName(slug), ...dependsOn]
	return `npx skills@latest add ${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName} ${skills.map((skill) => `--skill=${skill}`).join(' ')}`
}

/** The editable whole-set install line, shared with the /skills landing. */
export const SKILLS_INSTALL_ALL_COMMAND = SKILLS_PORTABLE_INSTALL_COMMAND

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
 * null when the post is not a list member or the list has fewer than THREE
 * entries: a fabricated "next" is worse than no pager.
 *
 * Three, not two. On a ring of two the wrap makes `prev` and `next` the same
 * entry — index 0 looks back to index 1 and forward to index 1 — so the pager
 * offered the one other skill twice, as if they were different destinations.
 * Three is the smallest ring where "previous" and "next" name different things.
 */
export function getSkillNeighbors(
	entries: SkillEntry[],
	slug: string,
): SkillNeighbors {
	const index = entries.findIndex((entry) => entry.slug === slug)
	if (index === -1 || entries.length < 3) return null

	const total = entries.length
	const current = entries[index]
	const prev = entries[(index - 1 + total) % total]
	const next = entries[(index + 1) % total]
	if (!current || !prev || !next) return null

	return { current, prev, next }
}
