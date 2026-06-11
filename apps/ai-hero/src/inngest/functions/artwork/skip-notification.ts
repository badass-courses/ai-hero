import { SLACK_ARTWORK_SKIP_REQUESTED_EVENT } from '@/inngest/events/artwork'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import { slackCall } from '@/utils/slack-client'

export const skipNotification = inngest.createFunction(
	{
		id: 'artwork-skip-notification',
		name: 'Artwork: mark a post notification skipped',
	},
	{ event: SLACK_ARTWORK_SKIP_REQUESTED_EVENT },
	async ({ event, step }) => {
		const { postId, channelId, originalMessageTs, skippedByUserId } = event.data

		await step.run('chat-update', async () => {
			try {
				await slackCall('chat.update', {
					channel: channelId,
					ts: originalMessageTs,
					text: `⏭ Skipped by <@${skippedByUserId}>`,
					blocks: [
						{
							type: 'context',
							elements: [
								{
									type: 'mrkdwn',
									text: `⏭ Skipped by <@${skippedByUserId}>`,
								},
							],
						},
					],
				})
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error)
				if (msg.includes('message_not_found')) {
					void log.warn('post.artwork.skip.message_not_found', {
						postId,
						originalMessageTs,
					})
					return
				}
				throw error
			}
		})

		void log.info('post.artwork.skipped', {
			postId,
			channelId,
			skippedByUserId,
		})

		return { postId, skippedByUserId }
	},
)
