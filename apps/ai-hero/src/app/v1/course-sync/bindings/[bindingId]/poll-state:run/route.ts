import { createHash } from 'node:crypto'

import { CourseSyncError } from '@/course-sync/errors'
import {
	authorizeCourseSyncRequest,
	courseSyncErrorResponse,
	courseSyncJson,
	idempotencyKey,
} from '@/course-sync/http'
import { AI_HERO_COURSE_SYNC_BINDING } from '@/course-sync/types'
import { env } from '@/env.mjs'

const INNGEST_APP_ID = 'ai-hero'
const COURSE_SYNC_POLLER_FUNCTION_ID = 'ai-hero-course-sync-detection-poller'
const INNGEST_RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

function findInngestRunId(value: unknown): string | null {
	if (typeof value === 'string') return INNGEST_RUN_ID.test(value) ? value : null
	if (Array.isArray(value)) {
		for (const item of value) {
			const runId = findInngestRunId(item)
			if (runId) return runId
		}
		return null
	}
	if (value && typeof value === 'object') {
		for (const item of Object.values(value)) {
			const runId = findInngestRunId(item)
			if (runId) return runId
		}
	}
	return null
}

export async function POST(
	request: Request,
	context: { params: Promise<{ bindingId: string }> },
) {
	try {
		authorizeCourseSyncRequest(request, 'operator')
		const { bindingId } = await context.params
		if (bindingId !== AI_HERO_COURSE_SYNC_BINDING.bindingId) {
			throw new CourseSyncError(
				'COURSE_SYNC_BINDING_NOT_FOUND',
				'Course sync binding not found.',
				404,
			)
		}
		const key = idempotencyKey(request)
		const invocationKey = `course-sync-poll:${createHash('sha256').update(key).digest('hex')}`
		const response = await fetch(
			`https://api.inngest.com/v2/apps/${INNGEST_APP_ID}/functions/${COURSE_SYNC_POLLER_FUNCTION_ID}/invoke`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${env.INNGEST_SIGNING_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					data: {
						bindingId,
						requestedBy: 'operator',
						reason: 'operator-requested-run-now',
					},
					idempotencyKey: invocationKey,
				}),
			},
		)
		if (!response.ok) {
			throw new CourseSyncError(
				'COURSE_SYNC_INNGEST_INVOKE_FAILED',
				`Inngest function invocation failed (${response.status}).`,
				502,
			)
		}
		const result = (await response.json()) as unknown
		const runId = findInngestRunId(result)
		if (!runId) {
			throw new CourseSyncError(
				'COURSE_SYNC_INNGEST_INVOKE_INVALID',
				'Inngest function invocation returned no run ID.',
				502,
			)
		}

		return courseSyncJson(
			{ accepted: true, bindingId, invocationKey, runId },
			202,
		)
	} catch (error) {
		return courseSyncErrorResponse(error)
	}
}
