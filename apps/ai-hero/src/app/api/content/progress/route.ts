import { NextRequest, NextResponse } from 'next/server'
import { captureContentProgress } from '@/lib/content-progress'
import { log } from '@/server/logger'
import { z } from 'zod'

import { retryOnceOnLockTimeout } from './retry-lock-timeout'

export async function POST(request: NextRequest) {
	try {
		const body = await request.json()
		const result = await retryOnceOnLockTimeout(() =>
			captureContentProgress(body),
		)

		if (result.status === 'captured') {
			return NextResponse.json({ ok: true }, { status: 201 })
		}

		return NextResponse.json(
			{ ok: true, status: result.status },
			{ status: 202 },
		)
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json(
				{ ok: false, error: 'Invalid content progress payload' },
				{ status: 400 },
			)
		}

		await log.error('api.content.progress.failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		return NextResponse.json(
			{ ok: false, error: 'Internal server error' },
			{ status: 500 },
		)
	}
}
