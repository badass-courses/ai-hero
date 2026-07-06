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

// Client-safe types + pure constants live in `skills-shared.ts` (this module
// imports `db`/`server/logger` and must never reach the client bundle).
// Imported for internal use AND re-exported so existing server call sites keep
// their import path.
import {
	isSkillPhaseTag,
	SKILL_PHASE_TAG_CONTEXT,
	SKILL_PHASE_UTILITY_NUMBER,
	type SkillEntry,
	type SkillPhase,
} from './skills-shared'

export {
	isSkillPhaseTag,
	SKILL_PHASE_TAG_CONTEXT,
	SKILL_PHASE_UTILITY_NUMBER,
} from './skills-shared'
export type { SkillEntry, SkillPhase } from './skills-shared'

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
