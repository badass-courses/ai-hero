'use server'

import { revalidateTag } from 'next/cache'
import { courseBuilderAdapter } from '@/db'
import { SKILL_CHANGELOG_PUBLISHED_EVENT } from '@/inngest/events/skill-changelog'
import { inngest } from '@/inngest/inngest.server'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { subject } from '@casl/ability'

import {
	SkillChangelogUpdateSchema,
	type SkillChangelog,
	type SkillChangelogAction,
	type SkillChangelogUpdate,
} from './skill-changelog'
import { getSkillChangelogForEdit } from './skill-changelog-query'
import { upsertPostToTypeSense } from './typesense-query'

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

export async function autoUpdateSkillChangelog(input: SkillChangelogUpdate) {
	return updateSkillChangelog(input, 'save', false)
}

export async function updateSkillChangelog(
	input: SkillChangelogUpdate,
	action: SkillChangelogAction = 'save',
	revalidate = true,
): Promise<SkillChangelog> {
	const parsed = SkillChangelogUpdateSchema.parse(input)
	const { session, ability } = await getServerAuthSession()
	const user = session?.user

	const current = await getSkillChangelogForEdit(parsed.id)
	if (!current) {
		await log.error('skill-changelog.update.notfound', {
			id: parsed.id,
			userId: user?.id,
			action,
		})
		throw new Error(`Skill changelog ${parsed.id} not found.`)
	}

	if (!user || !ability.can(action, subject('Content', current))) {
		await log.error('skill-changelog.update.unauthorized', {
			id: parsed.id,
			userId: user?.id,
			action,
		})
		throw new Error('Unauthorized')
	}

	const previousState = current.fields.state
	const nextState = parsed.fields.state ?? previousState
	const transitionedToPublished =
		previousState !== 'published' && nextState === 'published'

	const mergedFields = {
		...current.fields,
		...parsed.fields,
		slug: parsed.fields.slug || current.fields.slug,
	}

	try {
		await upsertPostToTypeSense(
			{ ...current, fields: mergedFields },
			action === 'publish' || action === 'unpublish' || action === 'archive'
				? action
				: 'save',
		)
	} catch (error) {
		await log.error('skill-changelog.update.typesense.failed', {
			id: parsed.id,
			error: getErrorMessage(error),
			action,
			userId: user.id,
		})
	}

	const updated = await courseBuilderAdapter.updateContentResourceFields({
		id: current.id,
		fields: mergedFields,
	})

	await log.info('skill-changelog.update.success', {
		id: parsed.id,
		action,
		userId: user.id,
		fields: Object.keys(parsed.fields),
		transitionedToPublished,
	})

	if (transitionedToPublished) {
		await inngest.send({
			name: SKILL_CHANGELOG_PUBLISHED_EVENT,
			data: { resourceId: current.id, slug: mergedFields.slug },
			user,
		})
	}

	if (revalidate) {
		revalidateTag('skill-changelog', 'max')
		revalidateTag('posts', 'max')
	}

	return updated as SkillChangelog
}
