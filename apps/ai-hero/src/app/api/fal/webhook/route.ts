import { NextRequest, NextResponse } from 'next/server'
import { ARTWORK_FAL_COMPLETED_EVENT } from '@/inngest/events/artwork'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import { z } from 'zod'

export const runtime = 'nodejs'

/**
 * Signal-only webhook for fal.ai job completion.
 *
 * IMPORTANT — defense in depth:
 *
 * The image URLs in fal's webhook payload are NOT propagated to Inngest.
 * This route fires `artwork/fal.completed` carrying ONLY the falRequestId
 * (and the batchId/postId we threaded through the webhook URL). The
 * generate-artwork function calls `fal.queue.result(falRequestId)`
 * directly to retrieve the authoritative image URLs and validates each
 * URL's hostname against the fal CDN allowlist before any image is
 * shown in Slack.
 *
 * A forged or unsigned webhook payload can therefore at worst cause a
 * no-op generation cycle (re-fetch returns nothing, hostname check
 * fails) — never a malicious URL injection into Cloudinary or
 * post.fields.coverImage.
 */

const FalWebhookPayloadSchema = z.object({
	request_id: z.string().min(1),
	status: z.string().optional(),
	gateway_request_id: z.string().optional(),
})

export async function POST(request: NextRequest) {
	const url = new URL(request.url)
	const batchId = url.searchParams.get('batchId')
	const postId = url.searchParams.get('postId')

	if (!batchId || !postId) {
		void log.warn('fal.webhook.missing_query_params', {
			hasBatchId: Boolean(batchId),
			hasPostId: Boolean(postId),
		})
		return new NextResponse('Missing batchId or postId', { status: 400 })
	}

	let payload: unknown
	try {
		payload = await request.json()
	} catch {
		void log.warn('fal.webhook.malformed_body', { batchId, postId })
		return new NextResponse('Malformed JSON', { status: 400 })
	}

	const parsed = FalWebhookPayloadSchema.safeParse(payload)
	if (!parsed.success) {
		void log.warn('fal.webhook.invalid_payload', {
			batchId,
			postId,
			error: parsed.error.message,
		})
		return new NextResponse('Invalid fal payload', { status: 400 })
	}

	const falRequestId = parsed.data.request_id

	void log.info('fal.webhook.received', {
		batchId,
		postId,
		falRequestId,
		status: parsed.data.status,
	})

	try {
		const sendResult = await inngest.send({
			id: `fal-completed:${falRequestId}`,
			name: ARTWORK_FAL_COMPLETED_EVENT,
			data: { batchId, postId, falRequestId },
		})
		void log.info('fal.webhook.inngest_dispatched', {
			batchId,
			postId,
			falRequestId,
			eventIds: (sendResult as { ids?: string[] }).ids,
		})
	} catch (error) {
		void log.error('fal.webhook.inngest_send_failed', {
			batchId,
			postId,
			falRequestId,
			error: error instanceof Error ? error.message : String(error),
		})
		// Return 500 so fal retries the webhook (up to 10× over 2h per their
		// docs). Better than silently swallowing a delivery failure.
		return new NextResponse('Inngest dispatch failed', { status: 500 })
	}

	return NextResponse.json({ ok: true })
}
