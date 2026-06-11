#!/usr/bin/env tsx
/**
 * Replay the artwork pipeline against an existing post without going
 * through Slack. Posts a tracker message in SLACK_CONTENT_CHANNEL_ID
 * (so the variants thread has somewhere to land) and fires the same
 * slack/artwork.generate.requested event the slash command would.
 *
 *   pnpm artwork:replay <slug-or-url>
 *
 * Bypasses the in-flight + cover-set guards so the same post can be
 * regenerated freely during local iteration.
 *
 * NOTE: this script intentionally avoids importing from `@/lib/posts-query`
 * because that file pulls in typesense-instantsearch-adapter which fails
 * to load cleanly under tsx. We do a direct Drizzle query instead.
 */
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { env } from '@/env.mjs'
import { SLACK_ARTWORK_GENERATE_REQUESTED_EVENT } from '@/inngest/events/artwork'
import { inngest } from '@/inngest/inngest.server'
import { parsePostSlug } from '@/utils/parse-post-slug'
import { slackCall } from '@/utils/slack-client'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'
import { and, eq, or, sql } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'

async function postTrackerMessage(post: {
	id: string
	type?: string
	fields: { title: string; slug: string; postType?: string }
}): Promise<string> {
	const channelId = env.SLACK_CONTENT_CHANNEL_ID
	if (!channelId || !env.SLACK_CONTENT_BOT_TOKEN) {
		throw new Error(
			'SLACK_CONTENT_CHANNEL_ID and SLACK_CONTENT_BOT_TOKEN must be set',
		)
	}
	const editUrl = `${env.NEXT_PUBLIC_URL}${getResourcePath(post.type ?? 'post', post.fields.slug, 'edit')}`
	const viewUrl = `${env.NEXT_PUBLIC_URL}${getResourcePath(post.type ?? 'post', post.fields.slug, 'view')}`
	const postType = post.fields.postType ?? 'article'
	const json = await slackCall(
		'chat.postMessage',
		{
			channel: channelId,
			text: `🎨 [replay] artwork for ${post.fields.title}`,
			blocks: [
				{
					type: 'section',
					text: {
						type: 'mrkdwn',
						text: `*[replay]* *${post.fields.title}*\n_${post.fields.slug}_ · _${postType}_ · <${viewUrl}|View> · <${editUrl}|Edit>`,
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
		},
		{ nonRetriableOnMissingToken: false },
	)
	if (!json.ts) {
		throw new Error(`Slack chat.postMessage returned no ts`)
	}
	return json.ts
}

async function main() {
	const arg = process.argv[2]?.trim()
	if (!arg) {
		console.error('Usage: pnpm artwork:replay <slug-or-url>')
		process.exit(1)
	}

	const slug = parsePostSlug(arg)
	if (!slug) {
		console.error(`Could not parse a slug from "${arg}"`)
		process.exit(1)
	}

	const resolved = (await db.query.contentResource.findFirst({
		where: and(
			or(eq(contentResource.type, 'post'), eq(contentResource.type, 'article')),
			or(
				eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, slug),
				eq(contentResource.id, slug),
			),
		),
	})) as
		| {
				id: string
				type?: string
				fields?: { title?: string; slug?: string; postType?: string }
		  }
		| undefined
	if (!resolved) {
		console.error(`Post not found: ${slug}`)
		process.exit(1)
	}
	if (!resolved.fields?.title || !resolved.fields?.slug) {
		console.error(
			`"${slug}" resolved but is missing title or slug — cannot generate artwork`,
		)
		process.exit(1)
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

	console.log(`> Resolved post ${post.id} (${post.fields.title})`)
	const trackerTs = await postTrackerMessage(post)
	console.log(`> Tracker message posted (ts=${trackerTs})`)

	const batchId = `batch_${uuid()}`
	const result = await inngest.send({
		id: `replay-cli:${post.id}:${trackerTs}`,
		name: SLACK_ARTWORK_GENERATE_REQUESTED_EVENT,
		data: {
			postId: post.id,
			channelId: env.SLACK_CONTENT_CHANNEL_ID ?? '',
			originalMessageTs: trackerTs,
			batchId,
			bypassGuards: true,
		},
	})
	console.log(
		`> Inngest event fired:`,
		(result as { ids?: string[] }).ids ?? result,
	)
	console.log(
		`Done. Variants will land as a thread reply on ${trackerTs} in ~60s.`,
	)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
