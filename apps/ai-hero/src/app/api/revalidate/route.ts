import { revalidateTag } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import { AI_CODING_DICTIONARY_SOURCE_CHANGED_EVENT } from '@/inngest/events/ai-coding-dictionary'
import { inngest } from '@/inngest/inngest.server'

export async function GET(request: NextRequest) {
	const tag = request.nextUrl.searchParams.get('tag')
	const secret = request.nextUrl.searchParams.get('secret')

	if (secret !== env.INNGEST_SIGNING_KEY) {
		return NextResponse.json({ error: 'Invalid secret' }, { status: 401 })
	}

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
