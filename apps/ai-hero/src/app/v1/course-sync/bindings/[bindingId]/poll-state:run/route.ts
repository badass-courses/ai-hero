import { createHash } from 'node:crypto'

import { CourseSyncError } from '@/course-sync/errors'
import {
	authorizeCourseSyncRequest,
	courseSyncErrorResponse,
	courseSyncJson,
	idempotencyKey,
} from '@/course-sync/http'
import { AI_HERO_COURSE_SYNC_BINDING } from '@/course-sync/types'
import { COURSE_SYNC_POLL_REQUESTED_EVENT } from '@/inngest/events/course-sync-poll'
import { inngest } from '@/inngest/inngest.server'

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
		const eventId = `course-sync-poll:${createHash('sha256').update(key).digest('hex')}`
		const result = await inngest.send({
			id: eventId,
			name: COURSE_SYNC_POLL_REQUESTED_EVENT,
			data: {
				bindingId,
				requestedBy: 'operator',
				reason: 'operator-requested-run-now',
			},
		})

		return courseSyncJson(
			{
				accepted: true,
				bindingId,
				eventId,
				inngestEventIds: (result as { ids?: string[] }).ids ?? [],
			},
			202,
		)
	} catch (error) {
		return courseSyncErrorResponse(error)
	}
}
