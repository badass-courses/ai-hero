import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { SLACK_ARTWORK_PICK_REQUESTED_EVENT } from '@/inngest/events/artwork'
import { inngest } from '@/inngest/inngest.server'
import { PostSchema } from '@/lib/posts'
import { buildVariantBlocks } from '@/lib/slack/artwork-blocks'
import { upsertPostToTypeSense } from '@/lib/typesense-query'
import { log } from '@/server/logger'
import { cloudinary } from '@/utils/cloudinary'
import { slackCall } from '@/utils/slack-client'
import { NonRetriableError } from 'inngest'

export const pickVariant = inngest.createFunction(
	{
		id: 'artwork-pick-variant',
		name: 'Artwork: pick a variant and write the cover',
		concurrency: { key: 'event.data.postId', limit: 1 },
	},
	{ event: SLACK_ARTWORK_PICK_REQUESTED_EVENT },
	async ({ event, step }) => {
		const {
			postId,
			channelId,
			threadTs,
			batchId,
			variantIndex,
			falUrl,
			pickedByUserId,
			originalMessageTs,
		} = event.data

		// Picks from any batch are allowed — old batches stay live for
		// comparison so the user can change their mind after regenerating.
		const post = await step.run('fetch-post', async () => {
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

		const cloudinaryResult = await step.run(
			'upload-to-cloudinary',
			async () => {
				try {
					const result = (await cloudinary.uploader.upload(falUrl, {
						public_id: `post_${postId}_${batchId}_v${variantIndex}`,
						folder: 'post-artwork',
						overwrite: true,
						resource_type: 'image',
					})) as { secure_url: string; public_id: string }
					return {
						secure_url: result.secure_url,
						public_id: result.public_id,
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error)
					if (
						/4\d\d|invalid|not found|unauthorized|forbidden/i.test(msg) &&
						!/timeout|503|502|504/i.test(msg)
					) {
						throw new NonRetriableError(`cloudinary upload failed: ${msg}`)
					}
					throw error
				}
			},
		)

		await step.run('write-cover', async () => {
			await courseBuilderAdapter.updateContentResourceFields({
				id: postId,
				fields: {
					...post.fields,
					coverImage: {
						url: cloudinaryResult.secure_url,
						alt: post.fields.title,
					},
				},
			})
		})

		// Direct Typesense sync — we deliberately skip updatePost / RESOURCE_UPDATED
		// because picking a cover is a metadata-only change that shouldn't bump
		// the post version or fan out to other update consumers. Refetch via
		// getContentResource inside the step so Date fields stay as Date objects
		// (step.run boundaries serialize them to strings).
		await step
			.run('sync-typesense', async () => {
				const fresh = await courseBuilderAdapter.getContentResource(postId)
				if (!fresh) return
				await upsertPostToTypeSense(fresh, 'save')
			})
			.catch((error) => {
				void log.warn('post.artwork.pick.typesense_sync_failed', {
					postId,
					error: error instanceof Error ? error.message : String(error),
				})
			})

		// Re-render keeps all variants + buttons live so the user can swap
		// or regenerate at any time. Picked variant gets primary styling.
		const falUrls =
			event.data.falUrls && event.data.falUrls.length > 0
				? event.data.falUrls
				: [falUrl]

		await step.run('update-thread-message', async () => {
			const variantBlocks = buildVariantBlocks({
				falUrls,
				pickedIndex: variantIndex,
				pickedByUserId,
			})

			await slackCall('chat.update', {
				channel: channelId,
				ts: threadTs,
				text: `✅ Picked variant ${variantIndex + 1} — change anytime`,
				blocks: variantBlocks,
				// Preserve metadata so subsequent Pick / Regenerate clicks still
				// carry the batchId, falUrls, and originalMessageTs context.
				metadata: {
					event_type: 'artwork_variants',
					event_payload: {
						postId,
						batchId,
						originalMessageTs,
						falUrls,
					},
				},
			}).catch((error) => {
				void log.warn('post.artwork.pick.update_thread_failed', {
					postId,
					batchId,
					variantIndex,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		})

		// Cache-bust per-pick (batchId+variantIndex) — Slack caches by URL
		// and would serve the prior pick's OG preview if we busted on batchId
		// alone, since the same batch can be re-picked.
		const ogPreviewUrl = `${env.NEXT_PUBLIC_URL}/api/og?resource=${encodeURIComponent(
			post.fields.slug,
		)}&v=${encodeURIComponent(`${batchId}_v${variantIndex}`)}`

		await step.run('update-original', async () => {
			await slackCall('chat.update', {
				channel: channelId,
				ts: originalMessageTs,
				text: `✅ Cover set for ${post.fields.title}`,
				blocks: [
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*${post.fields.title}*\n_${post.fields.slug}_`,
						},
					},
					{
						type: 'image',
						image_url: ogPreviewUrl,
						alt_text: `OG preview for ${post.fields.title}`,
						title: { type: 'plain_text', text: 'OG preview' },
					},
					{
						type: 'image',
						image_url: cloudinaryResult.secure_url,
						alt_text: `Picked artwork for ${post.fields.title}`,
						title: { type: 'plain_text', text: 'Picked artwork' },
					},
					{
						type: 'context',
						elements: [
							{
								type: 'mrkdwn',
								text: `✅ Cover set — variant ${variantIndex + 1} picked by <@${pickedByUserId}> · <${cloudinaryResult.secure_url}|View full size>`,
							},
						],
					},
				],
			}).catch((error) => {
				void log.warn('post.artwork.pick.update_original_failed', {
					postId,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		})

		void log.info('post.artwork.variant.picked', {
			postId,
			batchId,
			variantIndex,
			coverUrl: cloudinaryResult.secure_url,
			pickedByUserId,
		})

		return {
			postId,
			batchId,
			variantIndex,
			coverUrl: cloudinaryResult.secure_url,
		}
	},
)
