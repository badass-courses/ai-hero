import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { ARTWORK_ACTION_IDS } from '@/inngest/events/artwork'
import { RESOURCE_CREATED_EVENT } from '@/inngest/events/resource-management'
import { inngest } from '@/inngest/inngest.server'
import { PostSchema } from '@/lib/posts'
import { log } from '@/server/logger'
import { slackCall } from '@/utils/slack-client'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'
import { NonRetriableError } from 'inngest'

export const notifyOnPostCreated = inngest.createFunction(
	{
		id: 'artwork-notify-on-post-created',
		name: 'Artwork: notify Slack when a post is created',
		idempotency: 'event.data.id',
	},
	{ event: RESOURCE_CREATED_EVENT, if: "event.data.type == 'post'" },
	async ({ event, step }) => {
		const postId = event.data.id
		const channelId = env.SLACK_CONTENT_CHANNEL_ID
		const botToken = env.SLACK_CONTENT_BOT_TOKEN

		// Preview deployments and local environments without Slack creds
		// emit RESOURCE_CREATED on every post — silently no-op rather than
		// flooding Inngest with NonRetriable failures for an opt-in pipeline.
		if (!channelId || !botToken) {
			void log.info('post.artwork.notify.skipped_no_config', {
				postId,
				hasChannelId: Boolean(channelId),
				hasBotToken: Boolean(botToken),
			})
			return { postId, skipped: 'no-config' as const }
		}

		const post = await step.run('fetch-post', async () => {
			const resource = await courseBuilderAdapter.getContentResource(postId)
			if (!resource) {
				throw new NonRetriableError(`Post not found: ${postId}`)
			}
			const parsed = PostSchema.safeParse(resource)
			if (!parsed.success) {
				throw new NonRetriableError(
					`Resource ${postId} did not parse as a Post: ${parsed.error.message}`,
				)
			}
			return parsed.data
		})

		const postType = post.fields.postType ?? 'article'
		const title = post.fields.title
		const editUrl = `${env.NEXT_PUBLIC_URL}${getResourcePath(
			post.type ?? 'post',
			post.fields.slug,
			'edit',
		)}`
		const viewUrl = `${env.NEXT_PUBLIC_URL}${getResourcePath(
			post.type ?? 'post',
			post.fields.slug,
			'view',
		)}`

		const response = await step.run('post-notification', async () => {
			return slackCall('chat.postMessage', {
				channel: channelId,
				text: `New post: ${title}`,
				blocks: [
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*${title}*\n_${post.fields.slug}_ · _${postType}_ · <${viewUrl}|View> · <${editUrl}|Edit>`,
						},
					},
					{
						type: 'actions',
						elements: [
							{
								type: 'button',
								style: 'primary',
								text: {
									type: 'plain_text',
									text: 'Generate Artwork',
									emoji: true,
								},
								action_id: ARTWORK_ACTION_IDS.generate,
								value: JSON.stringify({ postId }),
							},
							{
								type: 'button',
								text: { type: 'plain_text', text: 'Skip', emoji: true },
								action_id: ARTWORK_ACTION_IDS.skip,
								value: JSON.stringify({ postId }),
							},
						],
					},
				],
				metadata: {
					event_type: 'artwork_notification',
					event_payload: { postId },
				},
			})
		})

		void log.info('post.artwork.notify', {
			postId,
			channelId,
			messageTs: response.ts,
		})

		return { postId, messageTs: response.ts }
	},
)
