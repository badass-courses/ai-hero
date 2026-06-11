import { env } from '@/env.mjs'
import { NonRetriableError } from 'inngest'

const SLACK_API_BASE = 'https://slack.com/api'

type SlackApiResponse = {
	ok: boolean
	ts?: string
	error?: string
}

type SlackMethod =
	| 'chat.postMessage'
	| 'chat.update'
	| 'chat.postEphemeral'
	| 'chat.delete'

export type SlackCallOptions = {
	/**
	 * When `nonRetriableOnMissingToken` is true (default), a missing
	 * `SLACK_CONTENT_BOT_TOKEN` throws a NonRetriableError — appropriate
	 * inside Inngest handlers so failed runs don't retry forever. Set
	 * false for fire-and-forget callers (route handlers) that just want
	 * the call to no-op.
	 */
	nonRetriableOnMissingToken?: boolean
}

export async function slackCall(
	method: SlackMethod,
	body: Record<string, unknown>,
	options: SlackCallOptions = {},
): Promise<SlackApiResponse> {
	const { nonRetriableOnMissingToken = true } = options
	const botToken = env.SLACK_CONTENT_BOT_TOKEN
	if (!botToken) {
		if (nonRetriableOnMissingToken) {
			throw new NonRetriableError('SLACK_CONTENT_BOT_TOKEN missing')
		}
		return { ok: false, error: 'SLACK_CONTENT_BOT_TOKEN missing' }
	}
	const res = await fetch(`${SLACK_API_BASE}/${method}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${botToken}`,
			'content-type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify(body),
	})
	const json = (await res.json()) as SlackApiResponse
	if (!json.ok) {
		throw new Error(`Slack ${method} failed: ${json.error}`)
	}
	return json
}

export async function slackPostEphemeral(
	channelId: string,
	userId: string,
	text: string,
): Promise<void> {
	await slackCall(
		'chat.postEphemeral',
		{ channel: channelId, user: userId, text },
		{ nonRetriableOnMissingToken: false },
	).catch(() => {})
}
