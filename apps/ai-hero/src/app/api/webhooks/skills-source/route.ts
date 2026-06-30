import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { env } from '@/env.mjs'
import { GITHUB_SOURCE_SYNC_REQUESTED_EVENT } from '@/inngest/events/github-source'
import { inngest } from '@/inngest/inngest.server'

/**
 * GitHub push webhook for github-sourced posts. On a push to the default branch
 * it collects the changed file paths and dispatches a sync event, so a post
 * whose `githubSource` points at a changed file updates within seconds. The
 * hourly cron in `github-source-sync` is the backstop if a delivery is missed.
 */

const SKILLS_SOURCE_REF = 'refs/heads/main'

function timingSafeEqual(a: string, b: string) {
	const aBuffer = Buffer.from(a)
	const bBuffer = Buffer.from(b)

	return (
		aBuffer.length === bBuffer.length &&
		crypto.timingSafeEqual(aBuffer, bBuffer)
	)
}

function verifyGitHubSignature({
	body,
	signature,
	secret,
}: {
	body: string
	signature: string | null
	secret: string
}) {
	if (!signature?.startsWith('sha256=')) return false

	const expectedSignature = `sha256=${crypto
		.createHmac('sha256', secret)
		.update(body)
		.digest('hex')}`

	return timingSafeEqual(expectedSignature, signature)
}

type GitHubPushCommit = {
	added?: string[]
	modified?: string[]
	removed?: string[]
}

type GitHubPushPayload = {
	ref?: string
	repository?: {
		full_name?: string
	}
	commits?: GitHubPushCommit[]
}

export async function POST(request: NextRequest) {
	const secret = env.GITHUB_SKILLS_WEBHOOK_SECRET

	if (!secret) {
		return NextResponse.json(
			{ error: 'Skills source webhook secret is not configured' },
			{ status: 500 },
		)
	}

	const body = await request.text()
	const signature = request.headers.get('x-hub-signature-256')

	if (!verifyGitHubSignature({ body, signature, secret })) {
		return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
	}

	const event = request.headers.get('x-github-event')
	const deliveryId = request.headers.get('x-github-delivery') ?? undefined
	const payload = JSON.parse(body) as GitHubPushPayload

	if (event === 'ping') {
		return NextResponse.json({ ok: true, event })
	}

	if (event !== 'push') {
		return NextResponse.json({ ok: true, ignored: true, event })
	}

	if (payload.ref !== SKILLS_SOURCE_REF) {
		return NextResponse.json({ ok: true, ignored: true, ref: payload.ref })
	}

	const changedPaths = Array.from(
		new Set(
			(payload.commits ?? []).flatMap((commit) => [
				...(commit.added ?? []),
				...(commit.modified ?? []),
				...(commit.removed ?? []),
			]),
		),
	)

	await inngest.send({
		name: GITHUB_SOURCE_SYNC_REQUESTED_EVENT,
		data: {
			changedPaths,
			repositoryFullName: payload.repository?.full_name,
			ref: payload.ref,
			deliveryId,
			source: 'github-webhook',
		},
	})

	return NextResponse.json({
		ok: true,
		queued: true,
		changedPaths: changedPaths.length,
	})
}
