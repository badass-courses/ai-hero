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

/** True when a tag is scoped as a skill-phase tag via `fields.contexts`. */
export function isSkillPhaseTag(tag: Tag): boolean {
	return Boolean(tag.fields.contexts?.includes(SKILL_PHASE_TAG_CONTEXT))
}

/**
 * Phase badge metadata from a skill-phase tag, or null when the tag carries no
 * usable phase number (in which case the skill renders without a badge — a
 * missing phase NEVER drops a skill from the set).
 *
 * `fields.popularity_order` is the intended source. The slug fallback exists
 * because the phase tags were created by hand in a content-ops batch and the
 * ordering field is easy to leave unset; the conventional slugs ('phase-1' …
 * 'phase-7', 'phase-utility') then still carry the number.
 *
 * Lives here rather than in `skills-query.ts` because it is pure — no `db`, no
 * logger — so it is directly testable and safe for client callers.
 */
export function skillPhaseFromTag(tag: Tag): SkillPhase | null {
	const { label, slug, popularity_order } = tag.fields

	let number = popularity_order ?? null
	if (number === null) {
		const slugMatch = slug.match(/^phase-(\d+)$/)
		if (slugMatch?.[1]) {
			number = Number(slugMatch[1])
		} else if (slug === 'phase-utility') {
			number = SKILL_PHASE_UTILITY_NUMBER
		}
	}
	if (number === null) return null

	return {
		number,
		// 'Phase 1: Idea' -> 'Idea'; labels without the prefix pass through as-is.
		name: label.replace(/^phase\s*\d+\s*:\s*/i, '').trim() || label,
		label,
		slug,
	}
}
