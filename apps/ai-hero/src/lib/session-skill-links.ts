import 'server-only'
import { skillKey } from '@ai-hero/learner-agent/views'
import { skillLinksFrom } from '@/lib/learner-agent/session-extracts'
import type { SessionExtract } from '@/lib/session-extract'
import { getSkillEntries } from '@/lib/skills-query'
import { log } from '@/server/logger'

/**
 * Skill pages for the skills this extract runs, by `skillKey`, as site paths.
 * Reads the `/skills` catalog (cached) only when the session runs a skill.
 * A failed read leaves the skills unlinked; it never fails the lesson.
 */
export async function getSessionSkillLinks(
	extract: SessionExtract | null,
): Promise<Record<string, string>> {
	const used = new Set(
		(extract?.sessions ?? []).flatMap((session) =>
			session.entries.flatMap((entry) =>
				entry.kind === 'skillCall' ? [skillKey(entry.skill)] : [],
			),
		),
	)
	if (used.size === 0) return {}

	try {
		const links = new Map(
			skillLinksFrom(await getSkillEntries(), '').map((link) => [
				skillKey(link.skill),
				link.url,
			]),
		)
		return Object.fromEntries([...links].filter(([key]) => used.has(key)))
	} catch (error) {
		await log.warn('lesson.session_skill_links.failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		return {}
	}
}
