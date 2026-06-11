import { NextResponse, type NextRequest } from 'next/server'
import { inngest } from '@/inngest/inngest.server'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

import {
	MUX_WEBHOOK_EVENT,
	MuxWebhookEventSchema,
} from '@coursebuilder/core/inngest/video-processing/events/event-video-mux-webhook'

export const POST = withSkill(async (req: NextRequest) => {
	// todo: check MUX_WEBHOOK_SIGNING_SECRET to verify the request
	const muxWebhookEvent = MuxWebhookEventSchema.parse(await req.json())

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
