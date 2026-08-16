export type CourseSyncErrorCategory =
	| 'target_precondition'
	| 'source_validation'
	| 'lifecycle_conflict'
	| 'transient_dependency'
	| 'internal'

export type CourseSyncErrorOptions = {
	category?: CourseSyncErrorCategory
	retryable?: boolean
	details?: Record<string, unknown>
}

export class CourseSyncError extends Error {
	readonly category: CourseSyncErrorCategory
	readonly retryable: boolean
	readonly details?: Record<string, unknown>

	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		options: CourseSyncErrorOptions = {},
	) {
		super(message)
		// Inngest preserves Error.name and message across step boundaries, but it
		// does not preserve the prototype. Put the stable code in name so callers
		// never need instanceof to recover it.
		this.name = code
		this.category =
			options.category ?? (status >= 500 ? 'internal' : 'lifecycle_conflict')
		this.retryable = options.retryable ?? status >= 500
		this.details = options.details
	}
}

export function asCourseSyncError(error: unknown): CourseSyncError {
	return error instanceof CourseSyncError
		? error
		: new CourseSyncError(
				'COURSE_SYNC_INTERNAL_ERROR',
				error instanceof Error ? error.message : String(error),
				500,
				{ category: 'internal', retryable: true },
			)
}
