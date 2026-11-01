import { NextRequest, NextResponse } from 'next/server'
import {
	approveDrovrBroadcast,
	DROVR_APPROVAL_ACTION_ID,
	drovrBroadcastClientFromEnv,
	DrovrApprovalValueSchema,
	type DrovrApprovalOutcome,
} from '@/lib/drovr-broadcasts'
import { log } from '@/server/logger'
import {
	parseSlackInteractivityPayload,
	verifySlackSignature,
} from '@/utils/verify-slack-signature'
import { z } from 'zod'

const APPROVAL_CHANNEL_ID = 'C0211NSK3TP'

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

function getRequiredEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(`${name} is required`)
	return value
}

async function updateSlackMessage({
	responseUrl,
	text,
	shortlink,
}: {
	responseUrl?: string
	text: string
	shortlink: string
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
					],
				},
			],
		}),
	})
}

function describeDrovrOutcome(
	outcome: Exclude<DrovrApprovalOutcome, { status: 'refused' }>,
) {
	const report = outcome.report
	const progress = report
		? `phase ${report.phase ?? 'unknown'}, captured ${report.captured ?? 'unknown'}, sent ${report.sent ?? 'unknown'}`
		: 'status unreadable; read broadcast_status'
	return `drovr broadcast \`${outcome.broadcastId}\`: ${progress}`
}

async function approveDrovrAction(
	payload: z.infer<typeof SlackInteractionPayloadSchema>,
	rawValue: string,
) {
	const value = DrovrApprovalValueSchema.parse(JSON.parse(rawValue))
	const outcome = await approveDrovrBroadcast({
		value,
		approverSlackId: payload.user.id,
		client: drovrBroadcastClientFromEnv(),
	})

	if (outcome.status === 'refused') {
		await log.warn('slack.drovr_broadcast_approval.refused', {
			reason: outcome.reason,
			messageId: value.messageId,
			version: value.version,
			userId: payload.user.id,
			channelId: payload.channel.id,
		})
		return NextResponse.json(
			{
				response_type: 'ephemeral',
				text: `Approve and send refused: ${outcome.reason}`,
			},
			{ status: 200 },
		)
	}

	const verb =
		outcome.status === 'created'
			? 'Approved; drovr is sending'
			: 'Already approved; no second send'
	const text = `:robot_face: *${verb}* by <@${payload.user.id}>\n${describeDrovrOutcome(outcome)}\n${value.shortlink}`

	await updateSlackMessage({
		responseUrl: payload.response_url,
		text,
		shortlink: value.shortlink,
	})

	await log.info('slack.drovr_broadcast_approval.sent', {
		status: outcome.status,
		broadcastId: outcome.broadcastId,
		phase: outcome.report?.phase ?? null,
		captured: outcome.report?.captured ?? null,
		userId: payload.user.id,
		channelId: payload.channel.id,
	})

	return NextResponse.json({ ok: true })
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
		const drovrAction = payload.actions.find(
			(action) => action.action_id === DROVR_APPROVAL_ACTION_ID,
		)

		if (!drovrAction?.value) {
			return new NextResponse('Unsupported action', { status: 400 })
		}

		if (payload.channel.id !== APPROVAL_CHANNEL_ID) {
			return new NextResponse('Unsupported channel', { status: 403 })
		}

		return await approveDrovrAction(payload, drovrAction.value)
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
