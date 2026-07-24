import {
	decodeCourseSyncBindingSummary,
	decodeCourseSyncRunSummary,
	type CourseJsonDocumentV3,
} from '@ai-hero/course-sync-schema'

export class CourseSyncApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: unknown,
	) {
		super(`Course sync API failed (${status})`)
	}
}

export function createCourseSyncClient(input: {
	baseUrl: string
	token: string
	fetchImpl?: typeof fetch
}) {
	const fetchImpl = input.fetchImpl ?? fetch
	const call = async <T>(
		path: string,
		decode: (value: unknown) => T,
		init?: RequestInit,
	): Promise<T> => {
		const response = await fetchImpl(new URL(path, input.baseUrl), {
			...init,
			headers: {
				Authorization: `Bearer ${input.token}`,
				'Content-Type': 'application/json',
				...init?.headers,
			},
		})
		const body: unknown = await response.json()
		if (!response.ok) throw new CourseSyncApiError(response.status, body)
		return decode(body)
	}
	return {
		getSyncBinding(bindingId: string) {
			return call(
				`/v1/course-sync/bindings/${encodeURIComponent(bindingId)}`,
				decodeCourseSyncBindingSummary,
			)
		},
		stageSourceRevision(
			bindingId: string,
			manifest: CourseJsonDocumentV3,
			idempotencyKey: string,
		) {
			return call(
				`/v1/course-sync/bindings/${encodeURIComponent(bindingId)}/runs:stage`,
				decodeCourseSyncRunSummary,
				{
					method: 'POST',
					headers: { 'Idempotency-Key': idempotencyKey },
					body: JSON.stringify({ manifest }),
				},
			)
		},
		previewSyncRun(runId: string) {
			return call(
				`/v1/course-sync/runs/${encodeURIComponent(runId)}:preview`,
				decodeCourseSyncRunSummary,
				{ method: 'POST' },
			)
		},
		getSyncRun(runId: string) {
			return call(
				`/v1/course-sync/runs/${encodeURIComponent(runId)}`,
				decodeCourseSyncRunSummary,
			)
		},
		applyStagedSyncRun(runId: string, idempotencyKey: string) {
			return call(
				`/v1/course-sync/runs/${encodeURIComponent(runId)}:apply`,
				decodeCourseSyncRunSummary,
				{ method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
			)
		},
		rollbackSyncRun(runId: string, idempotencyKey: string) {
			return call(
				`/v1/course-sync/runs/${encodeURIComponent(runId)}:rollback`,
				decodeCourseSyncRunSummary,
				{ method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
			)
		},
	}
}
