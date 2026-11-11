import { type NextRequest } from 'next/server'
import { inngest } from '@/inngest/inngest.server'
import { verifyMuxSignature } from '@/lib/mux-webhook-signature'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

import {
	MUX_WEBHOOK_EVENT,
	MuxWebhookEventSchema,
} from '@coursebuilder/core/events/video'

export const POST = withSkill(async (req: NextRequest) => {
	// Verify against the raw body: Mux signs the exact bytes it sent (sec-20261019-040).
	const rawBody = await req.text()
	const verdict = verifyMuxSignature({
		rawBody,
		header: req.headers.get('mux-signature'),
		secret: process.env.MUX_WEBHOOK_SIGNING_SECRET,
	})
	if (!verdict.ok) {
		void log.warn('mux.webhook.rejected', { reason: verdict.reason })
		// Mux retries non-2xx deliveries, so a misconfigured secret delays events instead of losing them.
		return new Response('invalid signature', { status: 401 })
	}

	let json: unknown
	try {
		json = JSON.parse(rawBody)
	} catch {
		return new Response('invalid json', { status: 400 })
	}
	const parsed = MuxWebhookEventSchema.safeParse(json)
	if (!parsed.success) {
		void log.warn('mux.webhook.unparsed', {
			issues: parsed.error.issues.length,
		})
		return new Response('unrecognised event', { status: 400 })
	}
	const muxWebhookEvent = parsed.data

	void log.info('mux.webhook.received', {
		eventType: muxWebhookEvent.type,
		objectId: muxWebhookEvent.object.id,
	})

	await inngest.send({
		name: MUX_WEBHOOK_EVENT,
		data: {
			muxWebhookEvent,
		},
	})

	return new Response('ok', {
		status: 200,
	})
})
