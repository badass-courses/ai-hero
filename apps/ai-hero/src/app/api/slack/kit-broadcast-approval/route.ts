import { NextRequest, NextResponse } from 'next/server'
import {
	AI_HERO_SKILLS_FROM_ADDRESS,
	AI_HERO_SKILLS_TEMPLATE_ID,
	AiHeroSkillsSubscriberFilter,
} from '@/lib/kit-broadcasts'
import { log } from '@/server/logger'
import {
	parseSlackInteractivityPayload,
	verifySlackSignature,
} from '@/utils/verify-slack-signature'
import { z } from 'zod'

const KIT_BASE = 'https://api.kit.com/v4'
const APPROVAL_ACTION_ID = 'ai_hero_skills_approve_and_send'
const APPROVAL_CHANNEL_ID = 'C0211NSK3TP'

const SlackActionValueSchema = z.object({
	broadcastId: z.number(),
	publicationId: z.number().optional(),
	subject: z.string().min(1),
	previewText: z.string().optional().nullable(),
	description: z.string().min(1),
	content: z.string().min(1),
	shortlink: z.string().url(),
})

const SlackInteractionPayloadSchema = z.object({
	type: z.string(),
	user: z.object({ id: z.string(), username: z.string().optional() }),
	channel: z.object({ id: z.string(), name: z.string().optional() }),
	message: z.object({ ts: z.string().optional() }).optional(),
	response_url: z.string().url().optional(),
	actions: z.array(
		z.object({
			action_id: z.string(),
			value: z.string().optional(),
		}),
	),
})

const KitBroadcastSchema = z.object({
	id: z.number(),
	publication_id: z.number().optional().nullable(),
	subject: z.string().optional().nullable(),
	preview_text: z.string().optional().nullable(),
	description: z.string().optional().nullable(),
	email_address: z.string().optional().nullable(),
	email_template: z
		.object({ id: z.number(), name: z.string().optional().nullable() })
		.optional()
		.nullable(),
	subscriber_filter: z.unknown().optional().nullable(),
	public: z.boolean().optional().nullable(),
	send_at: z.string().optional().nullable(),
	published_at: z.string().optional().nullable(),
})

const KitBroadcastResponseSchema = z.object({
	broadcast: KitBroadcastSchema,
})

function getRequiredEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(`${name} is required`)
	return value
}

async function kitFetch(path: string, init?: RequestInit) {
	const response = await fetch(`${KIT_BASE}${path}`, {
		...init,
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'X-Kit-Api-Key': getRequiredEnv('CONVERTKIT_V4_API_KEY'),
			...(init?.headers ?? {}),
		},
	})

	const text = await response.text()
	const json = text ? JSON.parse(text) : null

	if (!response.ok) {
		throw new Error(
			`Kit API returned ${response.status}: ${JSON.stringify(json ?? text)}`,
		)
	}

	return json
}

async function getKitBroadcast(broadcastId: number) {
	const parsed = KitBroadcastResponseSchema.parse(
		await kitFetch(`/broadcasts/${broadcastId}`),
	)
	return parsed.broadcast
}

function filtersMatchExpected(filter: unknown) {
	return JSON.stringify(filter) === JSON.stringify(AiHeroSkillsSubscriberFilter)
}

function assertBroadcastIsSafeToSend(
	broadcast: z.infer<typeof KitBroadcastSchema>,
) {
	if (broadcast.public !== false) {
		throw new Error('Broadcast is not a private draft')
	}
	if (broadcast.send_at !== null) {
		throw new Error('Broadcast already has a send_at value')
	}
	if (broadcast.published_at) {
		throw new Error('Broadcast is already published')
	}
	if (broadcast.email_template?.id !== AI_HERO_SKILLS_TEMPLATE_ID) {
		throw new Error('Broadcast template does not match AI Hero Skills template')
	}
	if (broadcast.email_address !== AI_HERO_SKILLS_FROM_ADDRESS) {
		throw new Error(
			'Broadcast from address does not match AI Hero Skills from address',
		)
	}
	if (!filtersMatchExpected(broadcast.subscriber_filter)) {
		throw new Error(
			'Broadcast subscriber filter does not match expected exclusions',
		)
	}
}

async function sendKitBroadcast(value: z.infer<typeof SlackActionValueSchema>) {
	const broadcast = await getKitBroadcast(value.broadcastId)
	assertBroadcastIsSafeToSend(broadcast)

	const sendAt = new Date().toISOString()
	const parsed = KitBroadcastResponseSchema.parse(
		await kitFetch(`/broadcasts/${value.broadcastId}`, {
			method: 'PUT',
			body: JSON.stringify({
				subject: value.subject,
				preview_text: value.previewText ?? '',
				description: value.description,
				content: value.content,
				public: true,
				send_at: sendAt,
				email_template_id: AI_HERO_SKILLS_TEMPLATE_ID,
				email_address: AI_HERO_SKILLS_FROM_ADDRESS,
				subscriber_filter: AiHeroSkillsSubscriberFilter,
			}),
		}),
	)

	return parsed.broadcast
}

async function updateSlackMessage({
	responseUrl,
	text,
	shortlink,
	kitUrl,
}: {
	responseUrl?: string
	text: string
	shortlink: string
	kitUrl: string
}) {
	if (!responseUrl) return

	await fetch(responseUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			replace_original: true,
			text,
			blocks: [
				{
					type: 'section',
					text: {
						type: 'mrkdwn',
						text,
					},
				},
				{
					type: 'actions',
					elements: [
						{
							type: 'button',
							text: {
								type: 'plain_text',
								text: 'Open shortlink',
								emoji: true,
							},
							url: shortlink,
						},
						{
							type: 'button',
							text: {
								type: 'plain_text',
								text: 'Open in Kit',
								emoji: true,
							},
							url: kitUrl,
						},
					],
				},
			],
		}),
	})
}

export async function POST(request: NextRequest) {
	const rawBody = await request.text()

	if (
		!verifySlackSignature(
			request,
			rawBody,
			getRequiredEnv('SLACK_SIGNING_SECRET'),
		)
	) {
		await log.warn('slack.kit_broadcast_approval.invalid_signature', {})
		return new NextResponse('Invalid Slack signature', { status: 401 })
	}

	try {
		const rawPayload = parseSlackInteractivityPayload(rawBody)
		if (!rawPayload) {
			return new NextResponse('Missing payload', { status: 400 })
		}

		const payload = SlackInteractionPayloadSchema.parse(rawPayload)
		const action = payload.actions.find(
			(action) => action.action_id === APPROVAL_ACTION_ID,
		)

		if (!action?.value) {
			return new NextResponse('Unsupported action', { status: 400 })
		}

		if (payload.channel.id !== APPROVAL_CHANNEL_ID) {
			return new NextResponse('Unsupported channel', { status: 403 })
		}

		const value = SlackActionValueSchema.parse(JSON.parse(action.value))
		const sentBroadcast = await sendKitBroadcast(value)
		const kitUrl = sentBroadcast.publication_id
			? `https://app.kit.com/publications/${sentBroadcast.publication_id}/reports/overview`
			: `https://app.kit.com/broadcasts/${sentBroadcast.id}`
		const text = `:robot_face: *Approved and sent* by <@${payload.user.id}>\n${value.shortlink}`

		await updateSlackMessage({
			responseUrl: payload.response_url,
			text,
			shortlink: value.shortlink,
			kitUrl,
		})

		await log.info('slack.kit_broadcast_approval.sent', {
			broadcastId: sentBroadcast.id,
			publicationId: sentBroadcast.publication_id,
			userId: payload.user.id,
			channelId: payload.channel.id,
		})

		return NextResponse.json({ ok: true })
	} catch (error) {
		await log.error('slack.kit_broadcast_approval.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
		})
		return NextResponse.json(
			{
				response_type: 'ephemeral',
				text: `Approve and send failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
			},
			{ status: 200 },
		)
	}
}
