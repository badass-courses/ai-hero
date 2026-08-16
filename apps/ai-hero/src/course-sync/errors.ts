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

export type CourseSyncErrorDto = {
	type: 'course-sync-error'
	code: string
	message: string
	status: number
	category: CourseSyncErrorCategory
	retryable: boolean
	details: Record<string, unknown> | null
}

export type CourseSyncStepResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: CourseSyncErrorDto }

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

function isCourseSyncErrorCategory(
	value: unknown,
): value is CourseSyncErrorCategory {
	return (
		value === 'target_precondition' ||
		value === 'source_validation' ||
		value === 'lifecycle_conflict' ||
		value === 'transient_dependency' ||
		value === 'internal'
	)
}

export function isCourseSyncErrorDto(
	value: unknown,
): value is CourseSyncErrorDto {
	if (!value || typeof value !== 'object') return false
	const candidate = value as Partial<CourseSyncErrorDto>
	return (
		candidate.type === 'course-sync-error' &&
		typeof candidate.code === 'string' &&
		typeof candidate.message === 'string' &&
		typeof candidate.status === 'number' &&
		isCourseSyncErrorCategory(candidate.category) &&
		typeof candidate.retryable === 'boolean' &&
		(candidate.details === null ||
			(typeof candidate.details === 'object' &&
				!Array.isArray(candidate.details)))
	)
}

export function courseSyncErrorDto(error: unknown): CourseSyncErrorDto {
	const failure = asCourseSyncError(error)
	return {
		type: 'course-sync-error',
		code: failure.code,
		message: failure.message,
		status: failure.status,
		category: failure.category,
		retryable: failure.retryable,
		details: failure.details ?? null,
	}
}

export function asCourseSyncError(error: unknown): CourseSyncError {
	if (error instanceof CourseSyncError) return error
	if (isCourseSyncErrorDto(error)) {
		return new CourseSyncError(error.code, error.message, error.status, {
			category: error.category,
			retryable: error.retryable,
			details: error.details ?? undefined,
		})
	}
	return new CourseSyncError(
		'COURSE_SYNC_INTERNAL_ERROR',
		error instanceof Error ? error.message : String(error),
		500,
		{ category: 'internal', retryable: true },
	)
}

export async function captureCourseSyncStepResult<T>(
	operation: () => Promise<T>,
): Promise<CourseSyncStepResult<T>> {
	try {
		return { ok: true, value: await operation() }
	} catch (error) {
		return { ok: false, error: courseSyncErrorDto(error) }
	}
}

export function unwrapCourseSyncStepResult<T>(
	result: CourseSyncStepResult<T>,
): T {
	if (result.ok) return result.value
	throw asCourseSyncError(result.error)
}
