import { revalidateTag } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { env } from '@/env.mjs'

const DICTIONARY_REPOS = [
	'mattpocock/dictionary-of-ai-coding',
	'mattpocock/ai-coding-dictionary',
]
const DICTIONARY_REF = 'refs/heads/main'
const DICTIONARY_CACHE_TAG = 'ai-coding-dictionary'

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

type GitHubWebhookPayload = {
	ref?: string
	repository?: {
		full_name?: string
	}
}

export async function POST(request: NextRequest) {
	const secret = env.AI_CODING_DICTIONARY_WEBHOOK_SECRET

	if (!secret) {
		return NextResponse.json(
			{ error: 'Dictionary webhook secret is not configured' },
			{ status: 500 },
		)
	}

	const body = await request.text()
	const signature = request.headers.get('x-hub-signature-256')

	if (!verifyGitHubSignature({ body, signature, secret })) {
		return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
	}

	const event = request.headers.get('x-github-event')
	const payload = JSON.parse(body) as GitHubWebhookPayload

	if (!DICTIONARY_REPOS.includes(payload.repository?.full_name ?? '')) {
		return NextResponse.json(
			{ error: 'Unexpected repository' },
			{ status: 400 },
		)
	}

	if (event === 'ping') {
		return NextResponse.json({ ok: true, event })
	}

	if (event !== 'push') {
		return NextResponse.json({ ok: true, ignored: true, event })
	}

	if (payload.ref !== DICTIONARY_REF) {
		return NextResponse.json({ ok: true, ignored: true, ref: payload.ref })
	}

	revalidateTag(DICTIONARY_CACHE_TAG, 'max')

	return NextResponse.json({
		ok: true,
		revalidated: true,
		tag: DICTIONARY_CACHE_TAG,
		now: Date.now(),
	})
}
