import { db } from '@/db'
import {
	courseSyncBinding,
	courseSyncPollLog,
	courseSyncPollState,
	courseSyncRun,
	courseSyncSourceRevision,
	courseSyncSourceRevisionAsset,
} from '@/db/schema'
import { asc, desc, eq, sql } from 'drizzle-orm'

export const courseSyncRevisionHistoryProjection = {
	sourceRevisionId: courseSyncSourceRevision.sourceRevisionId,
	bindingId: courseSyncSourceRevision.bindingId,
	courseVersionId: courseSyncSourceRevision.courseVersionId,
	providerRevision: courseSyncSourceRevision.providerRevision,
	manifestSha256: courseSyncSourceRevision.manifestSha256,
	stagedAt: courseSyncSourceRevision.stagedAt,
} as const

/**
 * Keep manifest-derived scalars in an unsorted query. PlanetScale otherwise puts
 * the 346 KB manifest in the sort buffer even when only JSON scalars are returned.
 */
export const courseSyncRevisionManifestSummaryProjection = {
	sourceRevisionId: courseSyncSourceRevision.sourceRevisionId,
	courseName: sql<
		string | null
	>`json_unquote(json_extract(${courseSyncSourceRevision.manifest}, '$.courseName'))`.as(
		'courseName',
	),
	sectionCount:
		sql<number>`cast(coalesce(json_length(json_extract(${courseSyncSourceRevision.manifest}, '$.sections')), 0) as unsigned)`.as(
			'sectionCount',
		),
	lessonCount: sql<number>`cast(coalesce((
		select sum(json_length(json_extract(section_row.section_json, '$.lessons')))
		from json_table(
			${courseSyncSourceRevision.manifest},
			'$.sections[*]' columns(section_json json path '$')
		) as section_row
	), 0) as unsigned)`.as('lessonCount'),
} as const

export const courseSyncRunHistoryProjection = {
	runId: courseSyncRun.runId,
	bindingId: courseSyncRun.bindingId,
	sourceRevisionId: courseSyncRun.sourceRevisionId,
	courseVersionId: courseSyncRun.courseVersionId,
	state: courseSyncRun.state,
	failureCode: courseSyncRun.failureCode,
	failureReason: courseSyncRun.failureReason,
	createdAt: courseSyncRun.createdAt,
	updatedAt: courseSyncRun.updatedAt,
} as const

export const courseSyncPollLogHistoryProjection = {
	id: courseSyncPollLog.id,
	bindingId: courseSyncPollLog.bindingId,
	courseVersionId: courseSyncPollLog.courseVersionId,
	providerRevision: courseSyncPollLog.providerRevision,
	runId: courseSyncPollLog.runId,
	controlPlaneRunId: courseSyncPollLog.controlPlaneRunId,
	stage: courseSyncPollLog.stage,
	outcome: courseSyncPollLog.outcome,
	failureClass: courseSyncPollLog.failureClass,
	occurredAt: courseSyncPollLog.occurredAt,
} as const

type RevisionRow = {
	sourceRevisionId: string
	bindingId: string
	courseVersionId: string
	providerRevision: string
	manifestSha256: string
	courseName: string | null
	sectionCount: number
	lessonCount: number
	stagedAt: Date
}

type AssetSummaryRow = {
	sourceRevisionId: string
	videoCount: number
	muxReadyCount: number
}

type RunRow = {
	runId: string
	bindingId: string
	sourceRevisionId: string
	courseVersionId: string
	state: string
	failureCode: string | null
	failureReason: string | null
	createdAt: Date
	updatedAt: Date
}

type PollLogRow = {
	id: string
	bindingId: string
	courseVersionId: string
	providerRevision: string
	runId: string
	controlPlaneRunId: string | null
	stage: string
	outcome: string
	failureClass: string | null
	occurredAt: Date
}

type PollStateRow = {
	bindingId: string
	courseVersionId: string
	providerRevision: string
	status: string
	consecutiveFailures: number
	controlPlaneRunId: string | null
	failureClass: string | null
	updatedAt: Date
}

type BindingRow = {
	bindingId: string
	sourceCourseId: string
	productId: string
	anchorWorkshopId: string
	status: string
}

export type CourseSyncHistorySource = {
	listRevisions(courseVersionId?: string): Promise<RevisionRow[]>
	listAssetSummaries(courseVersionId?: string): Promise<AssetSummaryRow[]>
	listRuns(courseVersionId?: string): Promise<RunRow[]>
	listPollLogs(courseVersionId?: string): Promise<PollLogRow[]>
	listPollStates(courseVersionId?: string): Promise<PollStateRow[]>
	listBindings(): Promise<BindingRow[]>
}

export const drizzleCourseSyncHistorySource: CourseSyncHistorySource = {
	async listRevisions(courseVersionId) {
		const metadataQuery = db
			.select(courseSyncRevisionHistoryProjection)
			.from(courseSyncSourceRevision)
		const summaryQuery = db
			.select(courseSyncRevisionManifestSummaryProjection)
			.from(courseSyncSourceRevision)
		const [metadata, summaries] = await Promise.all([
			courseVersionId
				? metadataQuery.where(
						eq(courseSyncSourceRevision.courseVersionId, courseVersionId),
					)
				: metadataQuery.orderBy(desc(courseSyncSourceRevision.stagedAt)),
			courseVersionId
				? summaryQuery.where(
						eq(courseSyncSourceRevision.courseVersionId, courseVersionId),
					)
				: summaryQuery,
		])
		const summaryByRevision = new Map(
			summaries.map((summary) => [summary.sourceRevisionId, summary]),
		)
		return metadata.map((revision) => {
			const summary = summaryByRevision.get(revision.sourceRevisionId)
			return {
				...revision,
				courseName: summary?.courseName ?? null,
				sectionCount: summary?.sectionCount ?? 0,
				lessonCount: summary?.lessonCount ?? 0,
			}
		})
	},
	async listAssetSummaries(courseVersionId) {
		const projection = {
			sourceRevisionId: courseSyncSourceRevisionAsset.sourceRevisionId,
			videoCount: sql<number>`cast(count(*) as unsigned)`.as('videoCount'),
			muxReadyCount:
				sql<number>`cast(sum(case when ${courseSyncSourceRevisionAsset.muxAssetId} is not null then 1 else 0 end) as unsigned)`.as(
					'muxReadyCount',
				),
		}
		const query = db
			.select(projection)
			.from(courseSyncSourceRevisionAsset)
			.innerJoin(
				courseSyncSourceRevision,
				eq(
					courseSyncSourceRevision.sourceRevisionId,
					courseSyncSourceRevisionAsset.sourceRevisionId,
				),
			)
		return courseVersionId
			? query
					.where(eq(courseSyncSourceRevision.courseVersionId, courseVersionId))
					.groupBy(courseSyncSourceRevisionAsset.sourceRevisionId)
			: query.groupBy(courseSyncSourceRevisionAsset.sourceRevisionId)
	},
	async listRuns(courseVersionId) {
		const query = db.select(courseSyncRunHistoryProjection).from(courseSyncRun)
		return courseVersionId
			? query
					.where(eq(courseSyncRun.courseVersionId, courseVersionId))
					.orderBy(asc(courseSyncRun.createdAt))
			: query.orderBy(desc(courseSyncRun.createdAt))
	},
	async listPollLogs(courseVersionId) {
		const query = db
			.select(courseSyncPollLogHistoryProjection)
			.from(courseSyncPollLog)
		return courseVersionId
			? query
					.where(eq(courseSyncPollLog.courseVersionId, courseVersionId))
					.orderBy(asc(courseSyncPollLog.occurredAt))
			: query.orderBy(desc(courseSyncPollLog.occurredAt))
	},
	async listPollStates(courseVersionId) {
		const projection = {
			bindingId: courseSyncPollState.bindingId,
			courseVersionId: courseSyncPollState.courseVersionId,
			providerRevision: courseSyncPollState.providerRevision,
			status: courseSyncPollState.status,
			consecutiveFailures: courseSyncPollState.consecutiveFailures,
			controlPlaneRunId: courseSyncPollState.controlPlaneRunId,
			failureClass: courseSyncPollState.failureClass,
			updatedAt: courseSyncPollState.updatedAt,
		}
		const query = db.select(projection).from(courseSyncPollState)
		return courseVersionId
			? query.where(eq(courseSyncPollState.courseVersionId, courseVersionId))
			: query
	},
	listBindings() {
		return db
			.select({
				bindingId: courseSyncBinding.bindingId,
				sourceCourseId: courseSyncBinding.sourceCourseId,
				productId: courseSyncBinding.productId,
				anchorWorkshopId: courseSyncBinding.anchorWorkshopId,
				status: courseSyncBinding.status,
			})
			.from(courseSyncBinding)
	},
}

export type CourseSyncHistoryOutcome = 'applied' | 'failed' | 'held' | 'staging'

export type CourseSyncHistoryEvent = {
	id: string
	stage: string
	outcome: string
	failureClass: string | null
	occurredAt: Date
	controlPlaneRunId: string | null
}

export type CourseSyncHistoryAttempt = {
	pollRunId: string
	startedAt: Date
	finishedAt: Date
	outcome: CourseSyncHistoryOutcome | 'skipped'
	failureClass: string | null
	controlPlaneRunId: string | null
	events: CourseSyncHistoryEvent[]
}

export type CourseSyncHistoryItem = {
	bindingId: string
	courseVersionId: string
	courseName: string | null
	providerRevision: string
	manifestSha256: string | null
	sourceRevisionId: string | null
	when: Date
	outcome: CourseSyncHistoryOutcome
	failureClass: string | null
	sectionCount: number | null
	lessonCount: number | null
	videoCount: number | null
	muxReadyCount: number | null
	durationSeconds: number | null
	runs: RunRow[]
	attempts: CourseSyncHistoryAttempt[]
	idlePollCount: number
	pollState: PollStateRow | null
	binding: BindingRow | null
}

function toNumber(value: number) {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function latestDate(dates: Array<Date | null | undefined>) {
	return new Date(
		Math.max(...dates.filter(Boolean).map((date) => date!.getTime())),
	)
}

function attemptOutcome(
	events: PollLogRow[],
): CourseSyncHistoryAttempt['outcome'] {
	if (events.some((event) => event.outcome === 'held')) return 'held'
	if (events.some((event) => event.outcome === 'failed')) return 'failed'
	if (
		events.some(
			(event) => event.stage === 'apply' && event.outcome === 'succeeded',
		)
	) {
		return 'applied'
	}
	if (events.some((event) => event.outcome === 'skipped')) return 'skipped'
	return 'staging'
}

function overallOutcome(input: {
	runs: RunRow[]
	logs: PollLogRow[]
	state: PollStateRow | null
}): { outcome: CourseSyncHistoryOutcome; failureClass: string | null } {
	const applied = [...input.runs]
		.reverse()
		.find((run) => run.state === 'applied')
	if (applied) return { outcome: 'applied', failureClass: null }

	const heldLog = [...input.logs]
		.reverse()
		.find((log) => log.outcome === 'held')
	if (input.state?.status === 'held' || heldLog) {
		return {
			outcome: 'held',
			failureClass: input.state?.failureClass ?? heldLog?.failureClass ?? null,
		}
	}

	const failedRun = [...input.runs]
		.reverse()
		.find((run) => run.state === 'failed')
	const failedLog = [...input.logs]
		.reverse()
		.find((log) => log.outcome === 'failed')
	if (input.state?.status === 'failed' || failedRun || failedLog) {
		return {
			outcome: 'failed',
			failureClass:
				input.state?.failureClass ??
				failedRun?.failureCode ??
				failedLog?.failureClass ??
				null,
		}
	}

	return { outcome: 'staging', failureClass: null }
}

/**
 * An idle cycle is a poll that woke up, saw the applied revision unchanged,
 * and went back to sleep. At one poll every 30 minutes they outnumber real
 * work ~50:1, so the page counts them instead of listing them.
 */
function isIdlePollCycle(attempt: CourseSyncHistoryAttempt) {
	return attempt.events.every(
		(event) =>
			event.stage === 'detect' ||
			(event.stage === 'compare' && event.outcome === 'skipped') ||
			(event.stage === 'notify' && event.outcome === 'skipped'),
	)
}

function buildAttempts(logs: PollLogRow[]): CourseSyncHistoryAttempt[] {
	const grouped = new Map<string, PollLogRow[]>()
	for (const log of [...logs].sort(
		(left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
	)) {
		const entries = grouped.get(log.runId) ?? []
		entries.push(log)
		grouped.set(log.runId, entries)
	}
	return [...grouped.entries()].map(([pollRunId, events]) => ({
		pollRunId,
		startedAt: events[0]!.occurredAt,
		finishedAt: events.at(-1)!.occurredAt,
		outcome: attemptOutcome(events),
		failureClass:
			[...events].reverse().find((event) => event.failureClass)?.failureClass ??
			null,
		controlPlaneRunId:
			[...events].reverse().find((event) => event.controlPlaneRunId)
				?.controlPlaneRunId ?? null,
		events: events.map((event) => ({
			id: event.id,
			stage: event.stage,
			outcome: event.outcome,
			failureClass: event.failureClass,
			occurredAt: event.occurredAt,
			controlPlaneRunId: event.controlPlaneRunId,
		})),
	}))
}

async function loadHistory(
	courseVersionId: string | undefined,
	source: CourseSyncHistorySource,
) {
	const [revisions, assetSummaries, runs, logs, states, bindings] =
		await Promise.all([
			source.listRevisions(courseVersionId),
			source.listAssetSummaries(courseVersionId),
			source.listRuns(courseVersionId),
			source.listPollLogs(courseVersionId),
			source.listPollStates(courseVersionId),
			source.listBindings(),
		])

	const versions = new Set<string>()
	for (const row of revisions) versions.add(row.courseVersionId)
	for (const row of runs) versions.add(row.courseVersionId)
	for (const row of logs)
		if (row.courseVersionId !== 'unknown') versions.add(row.courseVersionId)
	for (const row of states)
		if (row.courseVersionId !== 'unknown') versions.add(row.courseVersionId)

	return [...versions].map((versionId): CourseSyncHistoryItem => {
		const revision =
			revisions.find((row) => row.courseVersionId === versionId) ?? null
		const versionRuns = runs
			.filter((row) => row.courseVersionId === versionId)
			.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
		const versionLogs = logs
			.filter((row) => row.courseVersionId === versionId)
			.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
		const state =
			states.find((row) => row.courseVersionId === versionId) ?? null
		const assetSummary = revision
			? (assetSummaries.find(
					(row) => row.sourceRevisionId === revision.sourceRevisionId,
				) ?? null)
			: null
		const bindingId =
			revision?.bindingId ??
			versionRuns[0]?.bindingId ??
			versionLogs[0]?.bindingId ??
			state?.bindingId ??
			''
		const status = overallOutcome({
			runs: versionRuns,
			logs: versionLogs,
			state,
		})
		const allAttempts = buildAttempts(versionLogs)
		const attempts = allAttempts.filter(
			(attempt) => !isIdlePollCycle(attempt),
		)
		const timedAttempt =
			allAttempts.find((attempt) => attempt.outcome === 'applied') ??
			allAttempts.at(-1)
		const dates = [
			revision?.stagedAt,
			...versionRuns.flatMap((run) => [run.createdAt, run.updatedAt]),
			...versionLogs.map((log) => log.occurredAt),
			state?.updatedAt,
		]

		return {
			bindingId,
			courseVersionId: versionId,
			courseName: revision?.courseName ?? null,
			providerRevision:
				revision?.providerRevision ??
				state?.providerRevision ??
				versionLogs.at(-1)?.providerRevision ??
				'unknown',
			manifestSha256: revision?.manifestSha256 ?? null,
			sourceRevisionId: revision?.sourceRevisionId ?? null,
			when: latestDate(dates),
			outcome: status.outcome,
			failureClass: status.failureClass,
			sectionCount: revision ? toNumber(revision.sectionCount) : null,
			lessonCount: revision ? toNumber(revision.lessonCount) : null,
			videoCount: assetSummary ? toNumber(assetSummary.videoCount) : null,
			muxReadyCount: assetSummary ? toNumber(assetSummary.muxReadyCount) : null,
			durationSeconds: timedAttempt
				? Math.max(
						0,
						(timedAttempt.finishedAt.getTime() - timedAttempt.startedAt.getTime()) /
							1000,
					)
				: null,
			runs: versionRuns,
			attempts,
			idlePollCount: allAttempts.length - attempts.length,
			pollState: state,
			binding:
				bindings.find((binding) => binding.bindingId === bindingId) ?? null,
		}
	})
}

export async function listCourseSyncHistory(
	source: CourseSyncHistorySource = drizzleCourseSyncHistorySource,
) {
	const items = await loadHistory(undefined, source)
	return items.sort((left, right) => right.when.getTime() - left.when.getTime())
}

export async function getCourseSyncHistory(
	courseVersionId: string,
	source: CourseSyncHistorySource = drizzleCourseSyncHistorySource,
) {
	const items = await loadHistory(courseVersionId, source)
	return items.find((item) => item.courseVersionId === courseVersionId) ?? null
}
