import { courseBuilderAdapter } from '@/db'
import { SKILL_CHANGELOG_PUBLISHED_EVENT } from '@/inngest/events/skill-changelog'
import { inngest } from '@/inngest/inngest.server'
import {
	AI_HERO_SKILLS_EXCLUSION_TAG_IDS,
	AI_HERO_SKILLS_FROM_ADDRESS,
	AI_HERO_SKILLS_TEMPLATE_ID,
	createAiHeroSkillsBroadcast,
	KitBroadcastSentError,
	updateAiHeroSkillsBroadcast,
} from '@/lib/kit-broadcasts'
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
			operation: 'sync_kit_broadcast_for_skill_changelog',
			resourceId,
			slug,
			templateId: AI_HERO_SKILLS_TEMPLATE_ID,
			fromAddress: AI_HERO_SKILLS_FROM_ADDRESS,
			exclusionTagIds: [...AI_HERO_SKILLS_EXCLUSION_TAG_IDS],
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
			return { status: 'skipped', reason: 'resource_missing', resourceId, slug }
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

		const existingBroadcastId = resource.fields?.kitBroadcastId

		if (existingBroadcastId) {
			try {
				const broadcast = await step.run(
					'update Kit draft broadcast',
					async () => {
						return await updateAiHeroSkillsBroadcast(
							existingBroadcastId,
							broadcastInput,
						)
					},
				)

				await step.run('persist Kit broadcast metadata', async () => {
					await courseBuilderAdapter.updateContentResourceFields({
						id: resource.id,
						fields: {
							...resource.fields,
							kitBroadcastId: broadcast.id,
							kitBroadcastPublicationId: broadcast.publication_id ?? null,
							kitBroadcastUpdatedAt: new Date().toISOString(),
						},
					})
				})

				await log.info('skill-changelog.broadcast.updated', {
					operation: 'sync_kit_broadcast_for_skill_changelog',
					resourceId,
					slug,
					kitBroadcastId: broadcast.id,
				})

				return {
					status: 'updated',
					resourceId,
					slug,
					kitBroadcastId: broadcast.id,
					kitBroadcastPublicationId: broadcast.publication_id ?? null,
				}
			} catch (error) {
				if (error instanceof KitBroadcastSentError) {
					await log.warn('skill-changelog.broadcast.already_sent', {
						resourceId,
						slug,
						kitBroadcastId: existingBroadcastId,
					})
					return {
						status: 'skipped',
						reason: 'already_sent',
						resourceId,
						slug,
						kitBroadcastId: existingBroadcastId,
					}
				}
				throw error
			}
		}

		const broadcast = await step.run('create Kit draft broadcast', async () => {
			return await createAiHeroSkillsBroadcast(broadcastInput)
		})

		await step.run('persist Kit broadcast metadata', async () => {
			await courseBuilderAdapter.updateContentResourceFields({
				id: resource.id,
				fields: {
					...resource.fields,
					kitBroadcastId: broadcast.id,
					kitBroadcastPublicationId: broadcast.publication_id ?? null,
					kitBroadcastCreatedAt: new Date().toISOString(),
					kitBroadcastTemplateId: AI_HERO_SKILLS_TEMPLATE_ID,
					kitBroadcastFromAddress: AI_HERO_SKILLS_FROM_ADDRESS,
					kitBroadcastExclusionTagIds: [...AI_HERO_SKILLS_EXCLUSION_TAG_IDS],
				},
			})
		})

		await log.info('skill-changelog.broadcast.success', {
			operation: 'sync_kit_broadcast_for_skill_changelog',
			resourceId,
			slug,
			kitBroadcastId: broadcast.id,
			kitBroadcastPublicationId: broadcast.publication_id,
			templateId: AI_HERO_SKILLS_TEMPLATE_ID,
			fromAddress: AI_HERO_SKILLS_FROM_ADDRESS,
			exclusionTagIds: [...AI_HERO_SKILLS_EXCLUSION_TAG_IDS],
		})

		return {
			status: 'created',
			resourceId,
			slug,
			kitBroadcastId: broadcast.id,
			kitBroadcastPublicationId: broadcast.publication_id ?? null,
			templateId: AI_HERO_SKILLS_TEMPLATE_ID,
			fromAddress: AI_HERO_SKILLS_FROM_ADDRESS,
			exclusionTagIds: [...AI_HERO_SKILLS_EXCLUSION_TAG_IDS],
		}
	},
)
