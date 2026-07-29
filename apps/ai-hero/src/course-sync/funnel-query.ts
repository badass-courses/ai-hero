import { db } from '@/db'
import {
	courseSyncPollLog,
	courseSyncRun,
	courseSyncSourceRevision,
} from '@/db/schema'
import { asc, desc, eq, ne } from 'drizzle-orm'

import type { CourseSyncFunnelEntry } from './funnel'

export const courseSyncFunnelLogColumns = {
	occurredAt: true,
	stage: true,
	outcome: true,
	runId: true,
	controlPlaneRunId: true,
	failureClass: true,
	metadata: true,
} as const

export const courseSyncFunnelRevisionColumns = {
	sourceRevisionId: true,
	providerRevision: true,
	manifestSha256: true,
	stagedAt: true,
} as const

export const courseSyncFunnelRunColumns = {
	runId: true,
	state: true,
	planSha256: true,
	failureCode: true,
	createdAt: true,
	updatedAt: true,
} as const

export async function resolveCourseSyncFunnelVersion(
	requested: string | undefined,
) {
	if (requested && requested !== 'latest') return requested
	const latestLog = await db.query.courseSyncPollLog.findFirst({
		columns: { courseVersionId: true },
		where: ne(courseSyncPollLog.courseVersionId, 'unknown'),
		orderBy: desc(courseSyncPollLog.occurredAt),
	})
	if (latestLog) return latestLog.courseVersionId
	const latestRevision = await db.query.courseSyncSourceRevision.findFirst({
		columns: { courseVersionId: true },
		orderBy: desc(courseSyncSourceRevision.stagedAt),
	})
	if (latestRevision) return latestRevision.courseVersionId
	throw new Error('No course sync revision or detection log exists.')
}

export async function loadCourseSyncFunnelEntries(courseVersionId: string) {
	const [logs, revisions, runs] = await Promise.all([
		db.query.courseSyncPollLog.findMany({
			columns: courseSyncFunnelLogColumns,
			where: eq(courseSyncPollLog.courseVersionId, courseVersionId),
			orderBy: asc(courseSyncPollLog.occurredAt),
		}),
		db.query.courseSyncSourceRevision.findMany({
			columns: courseSyncFunnelRevisionColumns,
			where: eq(courseSyncSourceRevision.courseVersionId, courseVersionId),
			orderBy: asc(courseSyncSourceRevision.stagedAt),
		}),
		db.query.courseSyncRun.findMany({
			columns: courseSyncFunnelRunColumns,
			where: eq(courseSyncRun.courseVersionId, courseVersionId),
			orderBy: asc(courseSyncRun.createdAt),
		}),
	])

	return [
		...logs.map((entry) => ({
			timestamp: entry.occurredAt,
			stage: entry.stage,
			outcome: entry.outcome,
			pollRunId: entry.runId,
			controlPlaneRunId: entry.controlPlaneRunId,
			failureClass: entry.failureClass,
			metadata: entry.metadata,
		})),
		...revisions.map((revision) => ({
			timestamp: revision.stagedAt,
			stage: 'stage.receipt',
			outcome: 'persisted',
			metadata: {
				sourceRevisionId: revision.sourceRevisionId,
				providerRevision: revision.providerRevision,
				manifestSha256: revision.manifestSha256,
			},
		})),
		...runs.flatMap((run) => {
			const created: CourseSyncFunnelEntry = {
				timestamp: run.createdAt,
				stage: 'control-plane.run',
				outcome: 'created',
				controlPlaneRunId: run.runId,
				metadata: { planSha256: run.planSha256 },
			}
			const updated: CourseSyncFunnelEntry = {
				timestamp: run.updatedAt,
				stage: run.state === 'applied' ? 'apply.receipt' : 'control-plane.run',
				outcome: run.state,
				controlPlaneRunId: run.runId,
				failureClass: run.failureCode,
				metadata: { planSha256: run.planSha256 },
			}
			return [created, updated]
		}),
	] satisfies CourseSyncFunnelEntry[]
}
