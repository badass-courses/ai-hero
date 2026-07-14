/**
 * Server queries for skill entries — the joined, CMS-owned skill data model
 * (decided 2026-07-06, see specs/w2-skills-pages.md §2.2). Joins three CMS
 * sources:
 *
 * 1. the SKILLS_LIST_ID list (`list_ppwir`): membership + position = cycle
 *    order, and its `section` resources = catalog grouping (decided
 *    2026-07-14 — sections drive the /skills catalog, superseding the
 *    phase-tag core/utility split)
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

import { getListWithSections } from './lists-query'
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
	type SkillCatalogGroup,
	type SkillEntry,
	type SkillPhase,
} from './skills-shared'

export {
	isSkillPhaseTag,
	SKILL_PHASE_TAG_CONTEXT,
	SKILL_PHASE_UTILITY_NUMBER,
} from './skills-shared'
export type {
	SkillCatalogGroup,
	SkillEntry,
	SkillPhase,
} from './skills-shared'

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

/** Membership gate: published, public skill posts only. */
function isSkillMember(resource: any): boolean {
	return (
		resource?.type === 'post' &&
		resource?.fields?.postType === 'skill' &&
		resource?.fields?.state === 'published' &&
		resource?.fields?.visibility === 'public' &&
		typeof resource?.fields?.slug === 'string' &&
		typeof resource?.fields?.title === 'string'
	)
}

/**
 * Walk the deep (section-aware) skills list into catalog groups: a `section`
 * resource becomes a titled group of its member skills; consecutive loose
 * skills between/outside sections collapse into untitled runs. A section's own
 * state/visibility is ignored (sections are structural, created
 * draft+unlisted); empty groups are dropped. Positions run continuously across
 * the whole walk — that IS the cycle order.
 */
async function loadSkillCatalogGroups(): Promise<SkillCatalogGroup[]> {
	const list = await getListWithSections(SKILLS_LIST_ID)
	if (!list) {
		void log.error('skills.entries.list.missing', { listId: SKILLS_LIST_ID })
		return []
	}

	type PendingSkill = Omit<SkillEntry, 'phase'> & { phase: SkillPhase | null }
	const groups: Array<
		Omit<SkillCatalogGroup, 'skills'> & { skills: PendingSkill[] }
	> = []
	let position = 0
	let looseRun: (typeof groups)[number] | null = null

	const toPending = (resource: any): PendingSkill => ({
		id: resource.id as string,
		slug: resource.fields.slug as string,
		title: resource.fields.title as string,
		tagline:
			typeof resource.fields.description === 'string'
				? resource.fields.description
				: '',
		phase: null,
		position: position++,
	})

	for (const row of list.resources ?? []) {
		const resource = (row as any)?.resource
		if (!resource) continue

		if (resource.type === 'section') {
			const skills = (resource.resources ?? [])
				.map((child: any) => child?.resource)
				.filter(isSkillMember)
				.map(toPending)
			if (skills.length === 0) continue
			looseRun = null
			groups.push({
				id: resource.id as string,
				title:
					typeof resource.fields?.title === 'string'
						? resource.fields.title
						: 'Skills',
				description:
					typeof resource.fields?.description === 'string' &&
					resource.fields.description
						? resource.fields.description
						: undefined,
				skills,
			})
			continue
		}

		if (!isSkillMember(resource)) continue
		if (!looseRun) {
			looseRun = { id: `loose-${groups.length}`, title: null, skills: [] }
			groups.push(looseRun)
		}
		looseRun.skills.push(toPending(resource))
	}

	const allSkills = groups.flatMap((group) => group.skills)
	if (allSkills.length === 0) return []

	// Batch-load every member's tags in one query, then pick each post's
	// skill-phase tag (if any) — additive badge metadata only.
	const memberIds = allSkills.map((skill) => skill.id)
	const tagRows = await db.query.contentResourceTag.findMany({
		where: inArray(contentResourceTagTable.contentResourceId, memberIds),
		with: { tag: true },
	})

	const phaseByPostId = new Map<string, SkillPhase>()
	for (const tagRow of tagRows) {
		if (phaseByPostId.has(tagRow.contentResourceId)) continue
		const parsed = TagSchema.safeParse(tagRow.tag)
		if (!parsed.success || !isSkillPhaseTag(parsed.data)) continue
		const phase = skillPhaseFromTag(parsed.data)
		if (phase) phaseByPostId.set(tagRow.contentResourceId, phase)
	}

	for (const skill of allSkills) {
		skill.phase = phaseByPostId.get(skill.id) ?? null
	}

	return groups
}

/**
 * Cached catalog groups — CMS list sections with their member skills, for the
 * /skills catalog. Revalidates via the shared 'posts'/'tags'/'lists' tags
 * (skill posts, phase tags, and list membership/sections are each edited
 * through those surfaces).
 */
export const getSkillCatalogGroups = unstable_cache(
	loadSkillCatalogGroups,
	['skill-catalog-groups-v1'],
	{ revalidate: 3600, tags: ['posts', 'tags', 'lists'] },
)

/**
 * Cached FLAT skill entries in cycle order — the grouped walk flattened, so
 * consumers that don't care about sections (hub sidebar skills group,
 * SkillExtras) keep a simple ordered list even now that skills sit inside
 * `section` resources in the list.
 */
export const getSkillEntries = unstable_cache(
	async (): Promise<SkillEntry[]> =>
		(await loadSkillCatalogGroups()).flatMap((group) => group.skills),
	['skill-entries-v2'],
	{ revalidate: 3600, tags: ['posts', 'tags', 'lists'] },
)
