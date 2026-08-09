type SerializedAuthError = {
	name?: unknown
	type?: unknown
}

/** Generic AccessDenied can wrap callback infrastructure failures. Keep it loud. */
export function getNextAuthErrorLogLevel(
	_error: SerializedAuthError,
): 'info' | 'error' {
	return 'error'
}

export function getDiscordRefreshFailureKind(
	status: number,
	errorCode: string | null,
): 'user-must-relink' | 'failed' {
	return status === 400 && errorCode === 'invalid_grant'
		? 'user-must-relink'
		: 'failed'
}
