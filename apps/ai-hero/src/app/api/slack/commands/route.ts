import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import { SLACK_ARTWORK_GENERATE_REQUESTED_EVENT } from '@/inngest/events/artwork'
import { inngest } from '@/inngest/inngest.server'
import { getCachedPostOrList } from '@/lib/posts-query'
import { log } from '@/server/logger'
import { parsePostSlug } from '@/utils/parse-post-slug'
import { slackCall } from '@/utils/slack-client'
import { verifySlackSignature } from '@/utils/verify-slack-signature'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'
import { v4 as uuid } from 'uuid'

export const runtime = 'nodejs'

function ephemeralResponse(text: string) {
	return NextResponse.json({ response_type: 'ephemeral', text })
}

async function postTrackerMessage(
	channelId: string,
	post: {
		id: string
		type?: string
		fields: { title: string; slug: string; postType?: string }
	},
): Promise<string | null> {
	const editUrl = `${env.NEXT_PUBLIC_URL}${getResourcePath(post.type ?? 'post', post.fields.slug, 'edit')}`
	const viewUrl = `${env.NEXT_PUBLIC_URL}${getResourcePath(post.type ?? 'post', post.fields.slug, 'view')}`
	const postType = post.fields.postType ?? 'article'
	try {
		const json = await slackCall('chat.postMessage', {
			channel: channelId,
			text: `🎨 /artwork — generating for ${post.fields.title}`,
			blocks: [
				{
					type: 'section',
					text: {
						type: 'mrkdwn',
						text: `*${post.fields.title}*\n_${post.fields.slug}_ · _${postType}_ · <${viewUrl}|View> · <${editUrl}|Edit>`,
					},
				},
				{
					type: 'context',
					elements: [{ type: 'mrkdwn', text: '🎨 Generating artwork… (~60s)' }],
				},
			],
			metadata: {
				event_type: 'artwork_notification',
				event_payload: { postId: post.id },
			},
		})
		return json.ts ?? null
	} catch (error) {
		void log.error('slack.command.tracker_post_failed', {
			postId: post.id,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}

export async function POST(request: NextRequest) {
	const rawBody = await request.text()
	const signingSecret = env.SLACK_CONTENT_BOT_SIGNING_SECRET
	const botToken = env.SLACK_CONTENT_BOT_TOKEN
	const contentChannelId = env.SLACK_CONTENT_CHANNEL_ID

	if (
		!signingSecret ||
		!verifySlackSignature(request, rawBody, signingSecret)
	) {
		void log.warn('slack.command.invalid_signature', {})
		return new NextResponse('Invalid Slack signature', { status: 401 })
	}

	if (!botToken || !contentChannelId) {
		return ephemeralResponse(
			'Artwork pipeline not fully configured (SLACK_CONTENT_BOT_TOKEN / SLACK_CONTENT_CHANNEL_ID).',
		)
	}

	const form = new URLSearchParams(rawBody)
	const command = form.get('command') ?? ''
	const text = (form.get('text') ?? '').trim()
	const channelId = form.get('channel_id') ?? ''
	const userId = form.get('user_id') ?? ''

	if (channelId !== contentChannelId) {
		void log.warn('slack.command.wrong_channel', {
			command,
			channelId,
			userId,
		})
		return ephemeralResponse(
			`Use \`${command || '/artwork'}\` in <#${contentChannelId}>.`,
		)
	}

	if (!text) {
		return ephemeralResponse(
			'Usage: `/artwork <slug-or-url>` — e.g. `/artwork build-first-agent`',
		)
	}

	const slug = parsePostSlug(text)
	if (!slug) {
		return ephemeralResponse(`Could not parse a slug from \`${text}\`.`)
	}

	const resolved = (await getCachedPostOrList(slug)) as
		| {
				id: string
				type?: string
				fields?: { title?: string; slug?: string; postType?: string }
		  }
		| null
		| undefined
	if (!resolved) {
		return ephemeralResponse(`Post not found: \`${slug}\``)
	}

	const ARTWORKABLE_TYPES = new Set(['post', 'article'])
	if (!resolved.type || !ARTWORKABLE_TYPES.has(resolved.type)) {
		return ephemeralResponse(
			`\`${slug}\` is a ${resolved.type ?? 'non-post'} — /artwork supports posts and articles.`,
		)
	}

	if (!resolved.fields?.title || !resolved.fields?.slug) {
		return ephemeralResponse(
			`\`${slug}\` is missing title or slug — cannot generate artwork.`,
		)
	}

	const post = {
		id: resolved.id,
		type: resolved.type,
		fields: {
			title: resolved.fields.title,
			slug: resolved.fields.slug,
			postType: resolved.fields.postType,
		},
	}

	const trackerTs = await postTrackerMessage(channelId, post)
	if (!trackerTs) {
		return ephemeralResponse(
			'Could not post the tracker message in this channel — check the bot token and channel membership.',
		)
	}

	const batchId = `batch_${uuid()}`
	await inngest.send({
		id: `slash-gen:${channelId}:${trackerTs}`,
		name: SLACK_ARTWORK_GENERATE_REQUESTED_EVENT,
		data: {
			postId: post.id,
			channelId,
			originalMessageTs: trackerTs,
			batchId,
			bypassGuards: true,
		},
	})

	void log.info('slack.command.dispatched', {
		command,
		postId: post.id,
		slug,
		channelId,
		userId,
	})

	return ephemeralResponse(
		`Generating artwork for *${post.fields.title}* — variants will land as a thread reply.`,
	)
}
