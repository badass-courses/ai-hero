import { after, NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import {
	ARTWORK_ACTION_IDS,
	SLACK_ARTWORK_GENERATE_REQUESTED_EVENT,
	SLACK_ARTWORK_PICK_REQUESTED_EVENT,
	SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT,
	SLACK_ARTWORK_RETRY_REQUESTED_EVENT,
	SLACK_ARTWORK_SKIP_REQUESTED_EVENT,
} from '@/inngest/events/artwork'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import { slackPostEphemeral } from '@/utils/slack-client'
import {
	parseSlackInteractivityPayload,
	verifySlackSignature,
} from '@/utils/verify-slack-signature'
import { v4 as uuid } from 'uuid'
import { z } from 'zod'

export const runtime = 'nodejs'

const SlackPayloadSchema = z.object({
	type: z.string(),
	user: z.object({ id: z.string(), username: z.string().optional() }),
	channel: z.object({ id: z.string(), name: z.string().optional() }),
	message: z
		.object({
			ts: z.string().optional(),
			thread_ts: z.string().optional(),
			metadata: z
				.object({
					event_type: z.string().optional(),
					event_payload: z.record(z.any()).optional(),
				})
				.optional(),
		})
		.optional(),
	response_url: z.string().url().optional(),
	actions: z
		.array(
			z.object({
				action_id: z.string(),
				value: z.string().optional(),
				// Slack stamps each click with action_ts. Same value across
				// Slack retries of the same click; different across distinct
				// user clicks. Used as the dedup-id suffix so re-clicks on the
				// same button fire each time, but Slack retries collapse.
				action_ts: z.string().optional(),
			}),
		)
		.min(1),
})

export async function POST(request: NextRequest) {
	const rawBody = await request.text()
	const signingSecret = env.SLACK_CONTENT_BOT_SIGNING_SECRET

	if (
		!signingSecret ||
		!verifySlackSignature(request, rawBody, signingSecret)
	) {
		void log.warn('slack.interactivity.invalid_signature', {})
		return new NextResponse('Invalid Slack signature', { status: 401 })
	}

	const rawPayload = parseSlackInteractivityPayload(rawBody)
	if (!rawPayload) {
		return new NextResponse('Missing payload', { status: 400 })
	}

	const parsed = SlackPayloadSchema.safeParse(rawPayload)
	if (!parsed.success) {
		void log.warn('slack.interactivity.malformed_payload', {
			error: parsed.error.message,
		})
		return new NextResponse('Malformed payload', { status: 400 })
	}

	const payload = parsed.data
	const channelId = payload.channel.id
	const userId = payload.user.id
	// The clicked message's own ts. Downstream handlers use this to
	// chat.update the variant thread reply itself (mark "Picked",
	// supersede on regenerate). NOT payload.message.thread_ts — that's
	// the parent (original notification) ts and points to the wrong
	// message for variant-row updates.
	const clickedMessageTs = payload.message?.ts ?? ''
	const action = payload.actions[0]
	const actionId = action!.action_id
	// Per-click suffix appended to every Inngest dedup id below.
	// Slack retries of the same click share action_ts and collapse;
	// distinct user clicks each fire.
	const clickToken = action!.action_ts ?? `t${Date.now()}`

	if (channelId !== env.SLACK_CONTENT_CHANNEL_ID) {
		void log.warn('slack.interactivity.wrong_channel', {
			channelId,
			actionId,
		})
		return new NextResponse('Unsupported channel', { status: 403 })
	}

	const messageMetadata =
		(payload.message?.metadata?.event_payload as
			| Record<string, any>
			| undefined) ?? {}

	try {
		if (actionId === ARTWORK_ACTION_IDS.generate) {
			const buttonValue = action?.value
				? (JSON.parse(action.value) as { postId?: string })
				: {}
			const postId =
				buttonValue.postId ?? (messageMetadata.postId as string | undefined)
			if (!postId) {
				return new NextResponse('Missing postId', { status: 400 })
			}
			const batchId = `batch_${uuid()}`
			after(async () => {
				await inngest.send({
					id: `slack-gen:${channelId}:${clickedMessageTs}:${clickToken}`,
					name: SLACK_ARTWORK_GENERATE_REQUESTED_EVENT,
					data: {
						postId,
						channelId,
						originalMessageTs: clickedMessageTs,
						batchId,
					},
				})
				void log.info('slack.interactivity.dispatched', {
					actionId,
					postId,
					batchId,
					userId,
				})
			})
			return new NextResponse(null, { status: 200 })
		}

		if (actionId === ARTWORK_ACTION_IDS.regenerate) {
			const postId = messageMetadata.postId as string | undefined
			const currentArtworkBatchId = messageMetadata.batchId as
				| string
				| undefined
			const originalMessageTs = messageMetadata.originalMessageTs as
				| string
				| undefined
			if (!postId || !currentArtworkBatchId || !originalMessageTs) {
				after(() =>
					slackPostEphemeral(
						channelId,
						userId,
						'Regenerate from a variant message, not the original notification.',
					),
				)
				return new NextResponse(null, { status: 200 })
			}
			const batchId = `batch_${uuid()}`
			after(async () => {
				await inngest.send({
					id: `slack-regen:${channelId}:${currentArtworkBatchId}:${clickToken}`,
					name: SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT,
					data: {
						postId,
						channelId,
						threadTs: clickedMessageTs,
						originalMessageTs,
						batchId,
						currentArtworkBatchId,
					},
				})
				void log.info('slack.interactivity.dispatched', {
					actionId,
					postId,
					batchId: currentArtworkBatchId,
					userId,
				})
			})
			return new NextResponse(null, { status: 200 })
		}

		if (actionId.startsWith(ARTWORK_ACTION_IDS.pickPrefix)) {
			const variantIndex = Number(
				actionId.slice(ARTWORK_ACTION_IDS.pickPrefix.length),
			)
			const buttonValue = action?.value
				? (JSON.parse(action.value) as { falUrl?: string })
				: {}
			const falUrls = (messageMetadata.falUrls as string[] | undefined) ?? []
			const falUrl = buttonValue.falUrl ?? falUrls[variantIndex]
			const postId = messageMetadata.postId as string | undefined
			const batchId = messageMetadata.batchId as string | undefined
			const originalMessageTs = messageMetadata.originalMessageTs as
				| string
				| undefined
			if (
				!Number.isInteger(variantIndex) ||
				!falUrl ||
				!postId ||
				!batchId ||
				!originalMessageTs
			) {
				after(() =>
					slackPostEphemeral(
						channelId,
						userId,
						'Pick failed: missing variant context — try Regenerate.',
					),
				)
				return new NextResponse(null, { status: 200 })
			}
			after(async () => {
				await inngest.send({
					id: `slack-pick:${channelId}:${batchId}:${variantIndex}:${clickToken}`,
					name: SLACK_ARTWORK_PICK_REQUESTED_EVENT,
					data: {
						postId,
						channelId,
						threadTs: clickedMessageTs,
						batchId,
						variantIndex,
						falUrl,
						falUrls,
						pickedByUserId: userId,
						originalMessageTs,
					},
				})
				void log.info('slack.interactivity.dispatched', {
					actionId,
					postId,
					batchId,
					variantIndex,
					userId,
				})
			})
			return new NextResponse(null, { status: 200 })
		}

		if (actionId === ARTWORK_ACTION_IDS.skip) {
			const buttonValue = action?.value
				? (JSON.parse(action.value) as { postId?: string })
				: {}
			const postId =
				buttonValue.postId ?? (messageMetadata.postId as string | undefined)
			if (!postId) {
				return new NextResponse('Missing postId', { status: 400 })
			}
			after(async () => {
				await inngest.send({
					id: `slack-skip:${channelId}:${clickedMessageTs}:${clickToken}`,
					name: SLACK_ARTWORK_SKIP_REQUESTED_EVENT,
					data: {
						postId,
						channelId,
						originalMessageTs: clickedMessageTs,
						skippedByUserId: userId,
					},
				})
				void log.info('slack.interactivity.dispatched', {
					actionId,
					postId,
					userId,
				})
			})
			return new NextResponse(null, { status: 200 })
		}

		if (actionId === ARTWORK_ACTION_IDS.retry) {
			const retryStage = messageMetadata.retryStage as
				| 'generate'
				| 'pick'
				| undefined
			const postId = messageMetadata.postId as string | undefined
			const batchId = messageMetadata.batchId as string | undefined
			const originalMessageTs = messageMetadata.originalMessageTs as
				| string
				| undefined
			if (!retryStage || !postId || !originalMessageTs) {
				after(() =>
					slackPostEphemeral(
						channelId,
						userId,
						'Retry failed: missing failure context.',
					),
				)
				return new NextResponse(null, { status: 200 })
			}
			after(async () => {
				await inngest.send({
					id: `slack-retry:${channelId}:${clickedMessageTs}:${clickToken}`,
					name: SLACK_ARTWORK_RETRY_REQUESTED_EVENT,
					data: {
						postId,
						channelId,
						threadTs: clickedMessageTs,
						batchId: batchId ?? '',
						originalMessageTs,
						failureMessageTs: clickedMessageTs,
						retryStage,
						variantIndex: messageMetadata.variantIndex as number | undefined,
						falUrl: messageMetadata.falUrl as string | undefined,
						pickedByUserId: userId,
					},
				})
				void log.info('slack.interactivity.dispatched', {
					actionId,
					postId,
					retryStage,
					userId,
				})
			})
			return new NextResponse(null, { status: 200 })
		}

		void log.warn('slack.interactivity.unknown_action', { actionId })
		after(() =>
			slackPostEphemeral(channelId, userId, `Unknown action: ${actionId}`),
		)
		return new NextResponse(null, { status: 200 })
	} catch (error) {
		void log.error('slack.interactivity.dispatch_failed', {
			actionId,
			channelId,
			userId,
			error: error instanceof Error ? error.message : 'Unknown error',
		})
		return new NextResponse('Dispatch failed', { status: 500 })
	}
}
