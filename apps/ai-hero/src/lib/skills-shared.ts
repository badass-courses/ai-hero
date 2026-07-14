/**
 * Client-safe skill types + pure constants. Split out of `skills-query.ts`
 * (which imports `db` / `server/logger` → Node `async_hooks`) so that CLIENT
 * components — `SkillCycle`, the `/skills` catalog — can import the
 * `SkillEntry` type and the utility-phase sentinel without dragging server-only
 * modules into the browser bundle. `skills-query.ts` re-exports everything here
 * so existing server call sites are unaffected.
 *
 * Keep this module free of any server-only import (no `db`, no `server/*`).
 */

import { type Tag } from './tags'

/**
 * The `fields.contexts` value that scopes a topic tag to skill-phase duty.
 * Topic-tree/tag-filter consumers must EXCLUDE tags carrying this context
 * or phases leak into the topic UI.
 */
export const SKILL_PHASE_TAG_CONTEXT = 'skill-phase'

/** Sentinel `fields.popularity_order` value marking the utility (non-numbered) phase. */
export const SKILL_PHASE_UTILITY_NUMBER = 99

/**
 * Phase badge metadata derived from a skill post's `skill-phase`-context tag.
 */
export type SkillPhase = {
	/** Phase number from the tag's `fields.popularity_order` (utility = 99). Sort key. */
	number: number
	/** Display name with any "Phase N:" prefix stripped, e.g. 'Idea'. */
	name: string
	/** The tag's full `fields.label`, e.g. 'Phase 1: Idea'. */
	label: string
	/** The tag's slug, e.g. 'phase-1' or 'phase-utility'. */
	slug: string
}

/**
 * One skill in the cycle: list-ordered post identity + tagline + optional
 * phase badge. `phase: null` means "render without a badge" — a missing
 * phase tag never drops a skill from the set.
 */
export type SkillEntry = {
	/** The skill post's resource id. */
	id: string
	/** The post's flat `fields.slug` (skill URLs stay at root, e.g. /skills-grill-me). */
	slug: string
	/** The post's `fields.title`. */
	title: string
	/** GitHub-synced `fields.description` from the skill's SKILL.md frontmatter. */
	tagline: string
	/** Phase badge metadata, or null when the post has no skill-phase tag. */
	phase: SkillPhase | null
	/** Position within the skills list — this IS the cycle order. */
	position: number
}

/**
 * One catalog group on /skills: a CMS list `section` (title + optional
 * description) with its member skills, or an untitled run of loose skills
 * (`title: null`) for list members that sit outside any section. Group order
 * and member order both come from list positions.
 */
export type SkillCatalogGroup = {
	/** The section resource id, or a synthetic id for a loose run. */
	id: string
	/** The section's `fields.title`; null for loose (unsectioned) skills. */
	title: string | null
	/** The section's `fields.description`, when set. */
	description?: string
	/** Member skills in list order. */
	skills: SkillEntry[]
}

/** True when a tag is scoped as a skill-phase tag via `fields.contexts`. */
export function isSkillPhaseTag(tag: Tag): boolean {
	return Boolean(tag.fields.contexts?.includes(SKILL_PHASE_TAG_CONTEXT))
}
