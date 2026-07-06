/**
 * Server queries for skill entries — the joined, CMS-owned skill data model
 * (decided 2026-07-06, see specs/w2-skills-pages.md §2.2). Joins three CMS
 * sources into `SkillEntry[]`:
 *
 * 1. the SKILLS_LIST_ID list (`list_ppwir`): membership + position = cycle order
 * 2. phase tags (tags whose `fields.contexts` includes 'skill-phase') attached
 *    to each skill post — additive badge metadata, NEVER a membership gate
 * 3. taglines: each post's GitHub-synced `fields.description`
 *
 * No static config: everything is editable in the CMS without a deploy.
 */

import { unstable_cache } from 'next/cache'
import { db } from '@/db'
import { contentResourceTag as contentResourceTagTable } from '@/db/schema'
import { log } from '@/server/logger'
import { inArray } from 'drizzle-orm'

import { getList } from './lists-query'
import { SKILLS_LIST_ID } from './skills-content'
import { TagSchema, type Tag } from './tags'

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

function skillPhaseFromTag(tag: Tag): SkillPhase | null {
	const { label, slug, popularity_order } = tag.fields

	let number = popularity_order ?? null
	if (number === null) {
		// Fallback: derive from the conventional slug ('phase-1'..'phase-7',
		// 'phase-utility') when popularity_order wasn't set on the tag.
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

async function loadSkillEntries(): Promise<SkillEntry[]> {
	const list = await getList(SKILLS_LIST_ID)
	if (!list) {
		void log.error('skills.entries.list.missing', { listId: SKILLS_LIST_ID })
		return []
	}

	// List members arrive ordered by position (getList's orderBy); that order
	// IS the cycle order. Membership gate: published, public skill posts only.
	const members = (list.resources ?? [])
		.map((row: any, index: number) => ({
			position: typeof row?.position === 'number' ? row.position : index,
			resource: row?.resource,
		}))
		.filter(
			({ resource }) =>
				resource?.type === 'post' &&
				resource?.fields?.postType === 'skill' &&
				resource?.fields?.state === 'published' &&
				resource?.fields?.visibility === 'public' &&
				typeof resource?.fields?.slug === 'string' &&
				typeof resource?.fields?.title === 'string',
		)

	if (members.length === 0) return []

	// Batch-load every member's tags in one query, then pick each post's
	// skill-phase tag (if any).
	const memberIds = members.map(({ resource }) => resource.id as string)
	const tagRows = await db.query.contentResourceTag.findMany({
		where: inArray(contentResourceTagTable.contentResourceId, memberIds),
		with: { tag: true },
	})

	const phaseByPostId = new Map<string, SkillPhase>()
	for (const row of tagRows) {
		if (phaseByPostId.has(row.contentResourceId)) continue
		const parsed = TagSchema.safeParse(row.tag)
		if (!parsed.success || !isSkillPhaseTag(parsed.data)) continue
		const phase = skillPhaseFromTag(parsed.data)
		if (phase) phaseByPostId.set(row.contentResourceId, phase)
	}

	return members.map(({ resource, position }) => {
		const phase = phaseByPostId.get(resource.id) ?? null
		if (!phase) {
			// Additive metadata only — log and render without a badge.
			void log.warn('skills.entries.phase.missing', {
				postId: resource.id,
				slug: resource.fields.slug,
			})
		}
		return {
			id: resource.id as string,
			slug: resource.fields.slug as string,
			title: resource.fields.title as string,
			tagline:
				typeof resource.fields.description === 'string'
					? resource.fields.description
					: '',
			phase,
			position,
		}
	})
}

/**
 * Cached skill entries in cycle order. Revalidates via the shared
 * 'posts'/'tags'/'lists' tags (skill posts, phase tags, and list membership
 * are each edited through those surfaces).
 */
export const getSkillEntries = unstable_cache(
	loadSkillEntries,
	['skill-entries-v1'],
	{ revalidate: 3600, tags: ['posts', 'tags', 'lists'] },
)
