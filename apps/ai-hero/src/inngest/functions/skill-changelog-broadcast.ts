import { courseBuilderAdapter } from '@/db'
import {
	drovrBroadcastClientFromEnv,
	prepareDrovrSkillsMessage,
} from '@/lib/drovr-broadcasts'
import { SKILL_CHANGELOG_PUBLISHED_EVENT } from '@/inngest/events/skill-changelog'
import { inngest } from '@/inngest/inngest.server'
import { SKILL_CHANGELOG_RESOURCE_TYPE } from '@/lib/skill-changelog-query'
import { log } from '@/server/logger'

export const skillChangelogBroadcast = inngest.createFunction(
	{
		id: 'skill-changelog-broadcast',
		retries: 2,
		concurrency: {
			limit: 1,
			key: 'event.data.resourceId',
		},
	},
	{ event: SKILL_CHANGELOG_PUBLISHED_EVENT },
	async ({ event, step }) => {
		const { resourceId, slug } = event.data

		await log.info('skill-changelog.broadcast.started', {
			operation: 'prepare_drovr_message_for_skill_changelog',
			resourceId,
			slug,
		})

		const resource = await step.run(
			'load skill changelog resource',
			async () => {
				return await courseBuilderAdapter.getContentResource(resourceId)
			},
		)

		if (!resource) {
			await log.warn('skill-changelog.broadcast.resource_missing', {
				resourceId,
				slug,
			})
			return {
				status: 'skipped',
				reason: 'resource_missing',
				resourceId,
				slug,
			}
		}

		const isSkillChangelog =
			resource.type === SKILL_CHANGELOG_RESOURCE_TYPE ||
			resource.fields?.postType === SKILL_CHANGELOG_RESOURCE_TYPE

		if (!isSkillChangelog) {
			await log.warn('skill-changelog.broadcast.wrong_resource_type', {
				resourceId,
				slug,
				resourceType: resource.type,
				postType: resource.fields?.postType,
			})
			return {
				status: 'skipped',
				reason: 'wrong_resource_type',
				resourceId,
				slug,
			}
		}

		if (resource.fields?.state !== 'published') {
			await log.info('skill-changelog.broadcast.not_published', {
				resourceId,
				slug,
				state: resource.fields?.state,
			})
			return { status: 'skipped', reason: 'not_published', resourceId, slug }
		}

		const newsletterCopy = resource.fields?.newsletterCopy
		if (
			typeof newsletterCopy !== 'string' ||
			newsletterCopy.trim().length === 0
		) {
			await log.warn('skill-changelog.broadcast.newsletter_copy_missing', {
				resourceId,
				slug,
			})
			return {
				status: 'skipped',
				reason: 'newsletter_copy_missing',
				resourceId,
				slug,
			}
		}

		const broadcastInput = {
			subject:
				resource.fields?.newsletterSubject ||
				resource.fields?.title ||
				'AI Skills Changelog',
			content: newsletterCopy,
			previewText: resource.fields?.newsletterPreviewText,
			description: `AI Skills Changelog: ${resource.fields?.title ?? slug}`,
		}

		const prepared = await step.run('prepare drovr message', async () => {
			return await prepareDrovrSkillsMessage({
				existingMessageId: resource.fields?.drovrMessageId,
				slug,
				resourceId: resource.id,
				subject: broadcastInput.subject,
				previewText: broadcastInput.previewText,
				content: broadcastInput.content,
				client: drovrBroadcastClientFromEnv(),
			})
		})

		if (prepared.status === 'skipped') {
			await log.warn('skill-changelog.broadcast.drovr_skipped', {
				resourceId,
				slug,
				reason: prepared.reason,
			})
			return {
				status: 'skipped',
				reason: 'drovr_not_ready',
				detail: prepared.reason,
				resourceId,
				slug,
			}
		}

		await step.run('persist drovr message metadata', async () => {
			await courseBuilderAdapter.updateContentResourceFields({
				id: resource.id,
				fields: {
					...resource.fields,
					drovrMessageId: prepared.messageId,
					drovrMessagePath: prepared.path,
					drovrMessageFile: prepared.text,
					drovrMessageValidation: prepared.validation.status,
					drovrMessageReasons: prepared.validation.reasons,
					drovrMessagePreparedAt: new Date().toISOString(),
				},
			})
		})

		await log.info('skill-changelog.broadcast.drovr_prepared', {
			operation: 'prepare_drovr_message_for_skill_changelog',
			resourceId,
			slug,
			drovrMessageId: prepared.messageId,
			validation: prepared.validation.status,
			reasons: prepared.validation.reasons,
		})

		// Publishing the version is drovr's operator step, and only an
		// approver's Slack click creates the broadcast.
		return {
			status:
				prepared.validation.status === 'refused'
					? 'drovr_refused'
					: 'drovr_prepared',
			resourceId,
			slug,
			drovrMessageId: prepared.messageId,
			drovrMessagePath: prepared.path,
			validation: prepared.validation.status,
			reasons: prepared.validation.reasons,
		}
	},
)
