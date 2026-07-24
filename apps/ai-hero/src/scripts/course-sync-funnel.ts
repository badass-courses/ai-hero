import { db } from '@/db'
import {
	courseSyncPollLog,
	courseSyncRun,
	courseSyncSourceRevision,
} from '@/db/schema'
import {
	formatCourseSyncFunnel,
	type CourseSyncFunnelEntry,
} from '@/course-sync/funnel'
import { desc, eq, ne } from 'drizzle-orm'

async function resolveCourseVersionId(requested: string | undefined) {
	if (requested && requested !== 'latest') return requested
	const latestLog = await db.query.courseSyncPollLog.findFirst({
		where: ne(courseSyncPollLog.courseVersionId, 'unknown'),
		orderBy: desc(courseSyncPollLog.occurredAt),
	})
	if (latestLog) return latestLog.courseVersionId
	const latestRevision = await db.query.courseSyncSourceRevision.findFirst({
		orderBy: desc(courseSyncSourceRevision.stagedAt),
	})
	if (latestRevision) return latestRevision.courseVersionId
	throw new Error('No course sync revision or detection log exists.')
}

async function main() {
	const courseVersionId = await resolveCourseVersionId(process.argv[2])
	const [logs, revisions, runs] = await Promise.all([
		db.query.courseSyncPollLog.findMany({
			where: eq(courseSyncPollLog.courseVersionId, courseVersionId),
			orderBy: courseSyncPollLog.occurredAt,
		}),
		db.query.courseSyncSourceRevision.findMany({
			where: eq(courseSyncSourceRevision.courseVersionId, courseVersionId),
			orderBy: courseSyncSourceRevision.stagedAt,
		}),
		db.query.courseSyncRun.findMany({
			where: eq(courseSyncRun.courseVersionId, courseVersionId),
			orderBy: courseSyncRun.createdAt,
		}),
	])

	const entries: CourseSyncFunnelEntry[] = [
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
	]

	console.log(formatCourseSyncFunnel(courseVersionId, entries))
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
