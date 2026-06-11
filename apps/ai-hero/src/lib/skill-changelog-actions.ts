'use server'

import { courseBuilderAdapter } from '@/db'
import { SKILL_CHANGELOG_PUBLISHED_EVENT } from '@/inngest/events/skill-changelog'
import { inngest } from '@/inngest/inngest.server'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { subject } from '@casl/ability'

import { SKILL_CHANGELOG_RESOURCE_TYPE } from './skill-changelog-query'

export type TriggerSkillChangelogBroadcastResult =
	| { ok: true; eventId: string | null }
	| { ok: false; error: string }

export async function triggerSkillChangelogBroadcast(
	resourceId: string,
): Promise<TriggerSkillChangelogBroadcastResult> {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	if (!user) {
		return { ok: false, error: 'Unauthorized' }
	}

	const resource = await courseBuilderAdapter.getContentResource(resourceId)
	if (!resource) {
		return { ok: false, error: 'Resource not found' }
	}

	const isSkillChangelog =
		resource.type === SKILL_CHANGELOG_RESOURCE_TYPE ||
		resource.fields?.postType === SKILL_CHANGELOG_RESOURCE_TYPE

	if (!isSkillChangelog) {
		return { ok: false, error: 'Resource is not a skill changelog' }
	}

	if (!ability.can('manage', subject('Content', resource))) {
		return { ok: false, error: 'Unauthorized' }
	}

	const slug = resource.fields?.slug
	if (typeof slug !== 'string') {
		return { ok: false, error: 'Resource is missing a slug' }
	}

	const result = await inngest.send({
		name: SKILL_CHANGELOG_PUBLISHED_EVENT,
		data: { resourceId, slug },
		user,
	})

	const eventId = Array.isArray(result.ids) ? (result.ids[0] ?? null) : null

	await log.info('skill-changelog.broadcast.manually_triggered', {
		resourceId,
		slug,
		userId: user.id,
		eventId,
	})

	return { ok: true, eventId }
}
