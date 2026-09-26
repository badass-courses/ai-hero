import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { courseSyncRun } from '@/db/schema'

import { CourseSyncError } from './errors'
import { getServerCourseSyncBinding } from './types'

/** Resolve a run's binding from its durable row, never a caller-supplied hint. */
export async function getCourseSyncRunBinding(controlPlaneRunId: string) {
	const [run] = await db
		.select({ bindingId: courseSyncRun.bindingId })
		.from(courseSyncRun)
		.where(eq(courseSyncRun.runId, controlPlaneRunId))
		.limit(1)
	if (!run) {
		throw new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404)
	}
	return getServerCourseSyncBinding(run.bindingId)
}
