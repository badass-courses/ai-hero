export class CourseSyncError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message)
		this.name = 'CourseSyncError'
	}
}

export function asCourseSyncError(error: unknown): CourseSyncError {
	return error instanceof CourseSyncError
		? error
		: new CourseSyncError(
				'COURSE_SYNC_INTERNAL_ERROR',
				error instanceof Error ? error.message : String(error),
				500,
			)
}
