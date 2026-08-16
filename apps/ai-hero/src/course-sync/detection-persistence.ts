import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import {
	courseSyncPollLog,
	courseSyncPollState,
	courseSyncRun,
	courseSyncSourceRevision,
} from '@/db/schema'
import { log } from '@/server/logger'
import { and, desc, eq, isNull } from 'drizzle-orm'

import type {
	CourseSyncPollLogInput,
	CourseSyncPollState,
	CourseSyncRevisionHead,
} from './detection-poller'

export async function getCourseSyncRevisionHead(
	bindingId: string,
): Promise<CourseSyncRevisionHead | null> {
	const [[row], previousApplied] = await Promise.all([
		db
			.select({
				courseVersionId: courseSyncSourceRevision.courseVersionId,
				providerRevision: courseSyncSourceRevision.providerRevision,
				runId: courseSyncRun.runId,
				runState: courseSyncRun.state,
			})
			.from(courseSyncSourceRevision)
			.innerJoin(
				courseSyncRun,
				eq(
					courseSyncRun.sourceRevisionId,
					courseSyncSourceRevision.sourceRevisionId,
				),
			)
			.where(eq(courseSyncSourceRevision.bindingId, bindingId))
			.orderBy(
				desc(courseSyncSourceRevision.stagedAt),
				desc(courseSyncRun.updatedAt),
			)
			.limit(1),
		db.query.courseSyncRun.findFirst({
			columns: { runId: true },
			where: and(
				eq(courseSyncRun.bindingId, bindingId),
				eq(courseSyncRun.state, 'applied'),
				isNull(courseSyncRun.rollbackOfRunId),
			),
			orderBy: desc(courseSyncRun.updatedAt),
		}),
	])

	return row
		? {
				...row,
				runState: row.runState as CourseSyncRevisionHead['runState'],
				previousAppliedRunId: previousApplied?.runId ?? null,
			}
		: null
}

export async function getCourseSyncPollState(
	bindingId: string,
): Promise<CourseSyncPollState | null> {
	const row = await db.query.courseSyncPollState.findFirst({
		where: eq(courseSyncPollState.bindingId, bindingId),
	})
	return row
		? {
				...row,
				status: row.status as CourseSyncPollState['status'],
			}
		: null
}

export async function saveCourseSyncPollState(state: CourseSyncPollState) {
	await db
		.insert(courseSyncPollState)
		.values(state)
		.onDuplicateKeyUpdate({
			set: {
				courseVersionId: state.courseVersionId,
				providerRevision: state.providerRevision,
				status: state.status,
				consecutiveFailures: state.consecutiveFailures,
				controlPlaneRunId: state.controlPlaneRunId,
				failureClass: state.failureClass,
				updatedAt: state.updatedAt,
			},
		})
}

export async function appendCourseSyncPollLog(input: CourseSyncPollLogInput) {
	await db.insert(courseSyncPollLog).values({
		id: `cspl_${randomUUID()}`,
		...input,
		metadata: input.metadata ?? null,
		failureClass: input.failureClass ?? null,
		controlPlaneRunId: input.controlPlaneRunId ?? null,
	})
	const event = `course_sync.poll.${input.stage}.${input.outcome}`
	const attributes = {
		bindingId: input.bindingId,
		courseVersionId: input.courseVersionId,
		providerRevision: input.providerRevision,
		runId: input.runId,
		controlPlaneRunId: input.controlPlaneRunId ?? null,
		failureClass: input.failureClass ?? null,
		...input.metadata,
	}
	if (input.outcome === 'failed' || input.outcome === 'held') {
		await log.error(event, attributes)
	} else {
		await log.info(event, attributes)
	}
}
