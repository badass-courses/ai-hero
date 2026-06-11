import {
	SLACK_ARTWORK_GENERATE_REQUESTED_EVENT,
	SLACK_ARTWORK_PICK_REQUESTED_EVENT,
	SLACK_ARTWORK_RETRY_REQUESTED_EVENT,
} from '@/inngest/events/artwork'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import { slackCall } from '@/utils/slack-client'
import { NonRetriableError } from 'inngest'
import { v4 as uuid } from 'uuid'

export const retryHandler = inngest.createFunction(
	{
		id: 'artwork-retry-handler',
		name: 'Artwork: retry a failed generate or pick',
	},
	{ event: SLACK_ARTWORK_RETRY_REQUESTED_EVENT },
	async ({ event, step }) => {
		const {
			postId,
			channelId,
			threadTs,
			batchId,
			originalMessageTs,
			failureMessageTs,
			retryStage,
			variantIndex,
			falUrl,
			pickedByUserId,
		} = event.data

		// Visually mark the failure message as "retrying" so the user can't
		// double-click. Best-effort — Inngest event id-level dedup catches
		// duplicate retries upstream.
		await step
			.run('mark-retrying', async () => {
				await slackCall(
					'chat.update',
					{
						channel: channelId,
						ts: failureMessageTs,
						text: '🔄 Retrying…',
						blocks: [
							{
								type: 'context',
								elements: [{ type: 'mrkdwn', text: '🔄 Retrying…' }],
							},
						],
					},
					{ nonRetriableOnMissingToken: false },
				)
			})
			.catch(() => {})

		if (retryStage === 'generate') {
			const newBatchId = `batch_${uuid()}`
			await step.run('refire-generate', async () => {
				await inngest.send({
					// newBatchId is fresh per retry click — without it the dedup id
					// would collapse on the second retry of the same failure message.
					id: `slack-retry-gen:${channelId}:${originalMessageTs}:${newBatchId}`,
					name: SLACK_ARTWORK_GENERATE_REQUESTED_EVENT,
					data: {
						postId,
						channelId,
						originalMessageTs,
						batchId: newBatchId,
						bypassGuards: true,
					},
				})
			})
			void log.info('post.artwork.retry', {
				postId,
				retryStage,
				channelId,
			})
			return { postId, retryStage }
		}

		if (retryStage === 'pick') {
			if (
				typeof variantIndex !== 'number' ||
				!falUrl ||
				!batchId ||
				!pickedByUserId
			) {
				throw new NonRetriableError(
					'Pick retry missing required context (variantIndex, falUrl, batchId, pickedByUserId)',
				)
			}
			const retryToken = uuid()
			await step.run('refire-pick', async () => {
				await inngest.send({
					// retryToken is fresh per retry click — without it the dedup id
					// would collapse on the second retry of the same failure message.
					id: `slack-retry-pick:${channelId}:${batchId}:${variantIndex}:${retryToken}`,
					name: SLACK_ARTWORK_PICK_REQUESTED_EVENT,
					data: {
						postId,
						channelId,
						threadTs,
						batchId,
						variantIndex,
						falUrl,
						// Retry path doesn't have all four URLs — pass just the picked one;
						// pick-variant will gracefully render a single-image fallback.
						falUrls: [falUrl],
						pickedByUserId,
						originalMessageTs,
					},
				})
			})
			void log.info('post.artwork.retry', {
				postId,
				retryStage,
				batchId,
				variantIndex,
				channelId,
			})
			return { postId, retryStage, batchId, variantIndex }
		}

		throw new NonRetriableError(`Unknown retryStage: ${retryStage}`)
	},
)
