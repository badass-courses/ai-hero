import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import {
	ARTWORK_FAL_COMPLETED_EVENT,
	ARTWORK_GENERATION_FAILED_EVENT,
	ARTWORK_ACTION_IDS,
	SLACK_ARTWORK_GENERATE_REQUESTED_EVENT,
	SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT,
} from '@/inngest/events/artwork'
import { inngest } from '@/inngest/inngest.server'
import { serializeToMarkdown } from '@/lib/markdown-serializer'
import { PostSchema } from '@/lib/posts'
import { buildVariantBlocks } from '@/lib/slack/artwork-blocks'
import { log } from '@/server/logger'
import { slackCall } from '@/utils/slack-client'
import { gateway } from '@ai-sdk/gateway'
import { fal } from '@fal-ai/client'
import { generateText } from 'ai'
import { NonRetriableError } from 'inngest'

export const config = {
	maxDuration: 300,
}

const FAL_HOSTNAME_ALLOWLIST = ['fal.media', 'v3.fal.media', 'fal.ai']
const VARIANT_COUNT = 4
const FAL_LORA_MODEL = 'fal-ai/flux-2/lora'
const IN_FLIGHT_GUARD_MS = 90 * 1000

type ArtworkRequestEvent =
	| { name: typeof SLACK_ARTWORK_GENERATE_REQUESTED_EVENT; data: any }
	| { name: typeof SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT; data: any }

function isRegenerate(eventName: string): boolean {
	return eventName === SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT
}

function isAllowedFalHostname(url: string): boolean {
	try {
		const u = new URL(url)
		return FAL_HOSTNAME_ALLOWLIST.some(
			(host) => u.hostname === host || u.hostname.endsWith(`.${host}`),
		)
	} catch {
		return false
	}
}

function composeFinalPrompt(hookDescriptor: string): string {
	// `aiheroart` is the LoRA trigger word — required for the trained
	// style to activate. We pull toward solid forms ("large solid shapes")
	// rather than line work, which the LoRA tends to overdo otherwise.
	return (
		`aiheroart, A minimal geometric composition with ${hookDescriptor}, ` +
		`large solid shapes, edge to edge composition filling the entire frame, ` +
		`no text, no words, no letters`
	)
}

export const generateArtwork = inngest.createFunction(
	{
		id: 'artwork-generate-artwork',
		name: 'Artwork: generate variants from a post',
		concurrency: { key: 'event.data.postId', limit: 1 },
	},
	[
		{ event: SLACK_ARTWORK_GENERATE_REQUESTED_EVENT },
		{ event: SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT },
	],
	async ({ event, step }) => {
		const { data, name: eventName } = event as ArtworkRequestEvent
		const {
			postId,
			channelId,
			originalMessageTs,
			batchId,
			bypassGuards = false,
		} = data
		const isRegen = isRegenerate(eventName)
		const priorThreadTs = isRegen ? data.threadTs : null

		const requireConfig = (value: string | undefined, name: string): string => {
			if (!value) {
				throw new NonRetriableError(`${name} is required`)
			}
			return value
		}

		const falApiKey = requireConfig(env.FAL_API_KEY, 'FAL_API_KEY')
		const loraUrl = requireConfig(env.FAL_LORA_URL, 'FAL_LORA_URL')
		const publicUrl = env.NEXT_PUBLIC_URL
		fal.config({ credentials: falApiKey })

		const post = await step.run('check-post', async () => {
			const resource = await courseBuilderAdapter.getContentResource(postId)
			if (!resource) {
				throw new NonRetriableError(`Post not found: ${postId}`)
			}
			const parsed = PostSchema.safeParse(resource)
			if (!parsed.success) {
				throw new NonRetriableError(
					`Resource ${postId} did not parse as Post: ${parsed.error.message}`,
				)
			}
			return parsed.data
		})

		// Cover-already-set: skipped on bypass + regenerate (both explicit overwrite intents).
		if (!bypassGuards && !isRegen && post.fields.coverImage?.url) {
			void log.info('post.artwork.cover_already_set_warning', {
				postId,
				existingCoverUrl: post.fields.coverImage.url,
			})
		}

		// In-flight short-circuit for rapid double-clicks. Concurrency-1 already
		// serializes; this is just the friendlier "you're being too fast" path.
		if (!bypassGuards && !isRegen) {
			const startedAtRaw = post.fields._artwork?.startedAt
			if (startedAtRaw) {
				const startedAt = new Date(startedAtRaw).getTime()
				if (
					Number.isFinite(startedAt) &&
					Date.now() - startedAt < IN_FLIGHT_GUARD_MS
				) {
					void log.info('post.artwork.in_flight', {
						postId,
						startedAt: startedAtRaw,
					})
					return { skipped: 'in-flight', postId }
				}
			}
		}

		// batchId arrives on the trigger event so step.waitForEvent resumes via
		// `match: 'data.batchId'` — Inngest 3.54.x `if:` with literal-string
		// async.data comparison did not reliably resume waits.
		await step.run('mark-generating', async () => {
			await courseBuilderAdapter.updateContentResourceFields({
				id: postId,
				fields: {
					...post.fields,
					_artwork: {
						batchId,
						startedAt: new Date().toISOString(),
					},
				},
			})
		})

		await step.run('update-original-to-pending', async () => {
			await slackCall('chat.update', {
				channel: channelId,
				ts: originalMessageTs,
				text: `🎨 Generating artwork for ${post.fields.title}…`,
				blocks: [
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*${post.fields.title}*\n_${post.fields.slug}_`,
						},
					},
					{
						type: 'context',
						elements: [
							{ type: 'mrkdwn', text: '🎨 Generating artwork… (~60s)' },
						],
					},
				],
			}).catch((error) => {
				void log.warn('post.artwork.update_original_pending_failed', {
					postId,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		})

		const markdown = await step.run('serialize-post', async () => {
			return serializeToMarkdown(post)
		})

		let hookDescriptor = ''
		try {
			hookDescriptor = await step.run('extract-hook', async () => {
				const result = await generateText({
					model: gateway('anthropic/claude-haiku-4-5'),
					system:
						'You produce a short visual hook for a minimal abstract geometric cover image. Output ONLY 2-4 words, lowercase, naming a single concrete shape or form (no abstract concepts, no compound subjects, no "and"). The hook will be inserted into "A minimal geometric composition with ___, clean lines…". Examples: "a staircase form", "concentric rings", "a single archway", "an open doorway", "a circuit pathway", "a tall column". No prose, no explanation, no quotes, no trailing period.',
					prompt: `Post:\n\n${markdown.slice(0, 4000)}\n\nHook:`,
				})
				const text = result.text
					.trim()
					.replace(/^["']|["']$/g, '')
					.replace(/\.$/, '')
				return text
			})
			if (
				!hookDescriptor ||
				hookDescriptor.length < 3 ||
				hookDescriptor.length > 240
			) {
				hookDescriptor = post.fields.title
			}
		} catch (error) {
			void log.warn('post.artwork.extract_hook_failed', {
				postId,
				error: error instanceof Error ? error.message : String(error),
			})
			hookDescriptor = post.fields.title
		}

		const finalPrompt = composeFinalPrompt(hookDescriptor)
		const webhookUrl = `${publicUrl}/api/fal/webhook?batchId=${encodeURIComponent(
			batchId,
		)}&postId=${encodeURIComponent(postId)}`

		const submitResult = await step.run('submit-fal', async () => {
			try {
				return await fal.queue.submit(FAL_LORA_MODEL, {
					input: {
						prompt: finalPrompt,
						loras: [{ path: loraUrl, scale: 1.0 }],
						// FLUX 2 defaults — fewer steps and lower guidance than FLUX 1.
						// 1536×768 keeps the 2:1 OG strip aspect ratio.
						image_size: { width: 1536, height: 768 },
						num_inference_steps: 28,
						guidance_scale: 2.5,
						num_images: VARIANT_COUNT,
						enable_safety_checker: false,
					},
					webhookUrl,
				})
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error)
				if (/4\d\d|billing|quota|payment/i.test(msg)) {
					throw new NonRetriableError(`fal.queue.submit failed: ${msg}`)
				}
				throw error
			}
		})
		const falRequestId = (submitResult as { request_id: string }).request_id

		// Happy path is ~10s; 2m gives 12× headroom while still failing fast
		// when fal stalls (which it does intermittently — orphan completions
		// 30min+ later are useless to us since the user has moved on).
		// `match: 'data.batchId'` — same field on trigger and awaited events;
		// resolves to `event.data.batchId == async.data.batchId` server-side.
		const completion = await step.waitForEvent('await-fal', {
			event: ARTWORK_FAL_COMPLETED_EVENT,
			timeout: '2m',
			match: 'data.batchId',
		})

		if (!completion) {
			// Best-effort cancel of the stalled fal request. We swallow errors
			// inside the step so it always succeeds — fal returns 400 when
			// the request has already completed, which is fine; we just
			// didn't get a webhook in time.
			await step.run('cancel-stalled-fal', async () => {
				try {
					await fal.queue.cancel(FAL_LORA_MODEL, { requestId: falRequestId })
				} catch (error) {
					void log.warn('post.artwork.fal.cancel_failed', {
						postId,
						falRequestId,
						error: error instanceof Error ? error.message : String(error),
					})
				}
			})

			await emitFailure({
				step,
				stage: 'fal',
				message: 'fal stalled — click Retry to try again',
				postId,
				batchId,
				channelId,
				threadTs: priorThreadTs,
				originalMessageTs,
			})
			throw new NonRetriableError('fal generation timed out')
		}

		// SECURITY-CRITICAL: refetch URLs from fal directly. Webhook is
		// signal-only; never trust URLs in its payload.
		const imageUrls = await step.run('refetch-fal-status', async () => {
			const result = (await fal.queue.result(FAL_LORA_MODEL, {
				requestId: falRequestId,
			})) as { data?: { images?: { url: string }[] } }
			const images = result.data?.images ?? []
			return images.map((img) => img.url).filter(Boolean)
		})

		if (imageUrls.length === 0) {
			await emitFailure({
				step,
				stage: 'fal',
				message: 'fal returned no images',
				postId,
				batchId,
				channelId,
				threadTs: priorThreadTs,
				originalMessageTs,
			})
			throw new NonRetriableError('fal returned no images')
		}

		// SECURITY-CRITICAL: hostname allowlist
		const validatedUrls = await step.run('validate-image-urls', async () => {
			const invalid = imageUrls.filter((u) => !isAllowedFalHostname(u))
			if (invalid.length > 0) {
				throw new NonRetriableError(
					`untrusted image URL hostname: ${invalid.join(', ')}`,
				)
			}
			return imageUrls
		})

		const variantBlocks = buildVariantBlocks({
			falUrls: validatedUrls,
			hookDescriptor,
		})

		const variantThreadTs = await step.run('post-thread-reply', async () => {
			const json = await slackCall('chat.postMessage', {
				channel: channelId,
				thread_ts: originalMessageTs,
				text: `🎨 ${VARIANT_COUNT} variants for ${post.fields.title}`,
				unfurl_links: false,
				blocks: variantBlocks,
				metadata: {
					event_type: 'artwork_variants',
					event_payload: {
						postId,
						batchId,
						hookDescriptor,
						originalMessageTs,
						falUrls: validatedUrls,
					},
				},
			})
			return json.ts ?? ''
		})

		void log.info('post.artwork.variants.posted', {
			postId,
			batchId,
			falRequestId,
			variantCount: validatedUrls.length,
			hookDescriptor,
			variantThreadTs,
		})

		return {
			postId,
			batchId,
			falRequestId,
			variantThreadTs,
			variantCount: validatedUrls.length,
		}
	},
)

async function emitFailure({
	step,
	stage,
	message,
	postId,
	batchId,
	channelId,
	threadTs,
	originalMessageTs,
}: {
	step: any
	stage: 'llm' | 'fal' | 'cloudinary' | 'pick'
	message: string
	postId: string
	batchId: string | null
	channelId: string
	threadTs: string | null
	originalMessageTs: string
}) {
	await step.run('emit-failure', async () => {
		await inngest.send({
			name: ARTWORK_GENERATION_FAILED_EVENT,
			data: {
				postId,
				batchId,
				channelId,
				threadTs,
				originalMessageTs,
				stage,
				errorMessage: message,
			},
		})
	})

	await step
		.run('post-failure-thread-reply', async () => {
			await slackCall('chat.postMessage', {
				channel: channelId,
				thread_ts: originalMessageTs,
				text: `❌ Artwork generation failed (${stage}): ${message}`,
				blocks: [
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `❌ *Artwork generation failed* (${stage})\n${message}`,
						},
					},
					{
						type: 'actions',
						elements: [
							{
								type: 'button',
								text: { type: 'plain_text', text: '🔄 Retry', emoji: true },
								action_id: ARTWORK_ACTION_IDS.retry,
							},
						],
					},
				],
				metadata: {
					event_type: 'artwork_failure',
					event_payload: {
						postId,
						batchId,
						originalMessageTs,
						retryStage: 'generate',
					},
				},
			})
		})
		.catch(() => {
			// posting the failure reply is best-effort; the inngest event is the
			// source of truth for retries.
		})

	await step
		.run('update-original-failure', async () => {
			await slackCall('chat.update', {
				channel: channelId,
				ts: originalMessageTs,
				text: `❌ Artwork generation failed for this post`,
				blocks: [
					{
						type: 'context',
						elements: [
							{
								type: 'mrkdwn',
								text: `❌ Artwork generation failed (${stage})`,
							},
						],
					},
				],
			})
		})
		.catch(() => {})
}
