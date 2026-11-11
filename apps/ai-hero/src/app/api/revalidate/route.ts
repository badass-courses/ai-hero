import { revalidateTag } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import { AI_CODING_DICTIONARY_SOURCE_CHANGED_EVENT } from '@/inngest/events/ai-coding-dictionary'
import { inngest } from '@/inngest/inngest.server'

import { checkRevalidateAuth } from './revalidate-auth'

async function handle(request: NextRequest) {
	const auth = checkRevalidateAuth({
		configuredSecret: env.REVALIDATE_SECRET,
		authorization: request.headers.get('authorization'),
		hasQuerySecret: request.nextUrl.searchParams.has('secret'),
	})
	if (!auth.ok) {
		return NextResponse.json({ error: auth.error }, { status: auth.status })
	}

	const tag = request.nextUrl.searchParams.get('tag')
	if (!tag) {
		return NextResponse.json({ error: 'Missing tag param' }, { status: 400 })
	}

	revalidateTag(tag, 'max')

	if (tag === 'ai-coding-dictionary') {
		await inngest.send({
			name: AI_CODING_DICTIONARY_SOURCE_CHANGED_EVENT,
			data: { source: 'revalidate' },
		})
	}

	return NextResponse.json({ revalidated: true, tag, now: Date.now() })
}

export const GET = handle
export const POST = handle
