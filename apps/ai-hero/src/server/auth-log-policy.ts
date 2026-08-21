type SafeAuthErrorType =
	| 'AccessDenied'
	| 'AccountNotLinked'
	| 'AdapterError'
	| 'AuthError'
	| 'CallbackRouteError'
	| 'EmailSignInError'
	| 'EventError'
	| 'InvalidCallbackUrl'
	| 'InvalidCheck'
	| 'InvalidEndpoints'
	| 'InvalidProvider'
	| 'JWTSessionError'
	| 'MissingAdapter'
	| 'MissingAdapterMethods'
	| 'MissingCSRF'
	| 'MissingSecret'
	| 'OAuthAccountNotLinked'
	| 'OAuthCallbackError'
	| 'OAuthProfileParseError'
	| 'OAuthSignInError'
	| 'SessionTokenError'
	| 'SignOutError'
	| 'UntrustedHost'
	| 'Verification'
	| 'unknown'

type SafeAuthErrorKind = 'error' | 'signIn' | 'unknown'

type SafeAuthCauseCategory =
	| 'aggregate-error'
	| 'auth-error'
	| 'error'
	| 'range-error'
	| 'reference-error'
	| 'syntax-error'
	| 'type-error'
	| 'unknown'

type SafeAuthCauseCode =
	| 'EAI_AGAIN'
	| 'ECONNREFUSED'
	| 'ECONNRESET'
	| 'ENOTFOUND'
	| 'ETIMEDOUT'
	| 'UND_ERR_CONNECT_TIMEOUT'
	| 'access_denied'
	| 'invalid_grant'
	| 'invalid_request'
	| 'server_error'
	| 'temporarily_unavailable'
	| 'unknown'

type SafeAuthProvider = 'discord' | 'github' | 'postmark' | 'unknown'

type SafeAuthWarningCode =
	| 'csrf-disabled'
	| 'env-url-basepath-mismatch'
	| 'env-url-basepath-redundant'
	| 'unknown'

type AuthFailureKind =
	| 'account-not-linked'
	| 'adapter-failure'
	| 'callback-failure'
	| 'configuration-failure'
	| 'email-signin-failure'
	| 'magic-link-invalid'
	| 'oauth-callback-failure'
	| 'oauth-signin-failure'
	| 'sign-in-denied'
	| 'unknown-failure'

type AuthErrorLogData = {
	authErrorType: SafeAuthErrorType
	authErrorKind: SafeAuthErrorKind
	authCauseType: SafeAuthErrorType
	authCauseCategory: SafeAuthCauseCategory
	authCauseCode: SafeAuthCauseCode
	authFailureKind: AuthFailureKind
	provider: SafeAuthProvider
}

type OAuthCallbackResultCode =
	| 'access_denied'
	| 'invalid_request'
	| 'server_error'
	| 'temporarily_unavailable'
	| 'unknown'

type OAuthCallbackFailureKind =
	| 'invalid-request'
	| 'provider-unavailable'
	| 'user-denied'
	| 'unknown-oauth-failure'

type OAuthCallbackLogData = {
	authFailureKind: OAuthCallbackFailureKind
	oauthResultCode: OAuthCallbackResultCode
	provider: SafeAuthProvider
}

type ReflectionState = { failed: boolean }

function createAllUnknownAuthErrorLogData(): AuthErrorLogData {
	return {
		authErrorType: 'unknown',
		authErrorKind: 'unknown',
		authCauseType: 'unknown',
		authCauseCategory: 'unknown',
		authCauseCode: 'unknown',
		authFailureKind: 'unknown-failure',
		provider: 'unknown',
	}
}

function createAllUnknownOAuthCallbackLogData(): OAuthCallbackLogData {
	return {
		authFailureKind: 'unknown-oauth-failure',
		oauthResultCode: 'unknown',
		provider: 'unknown',
	}
}

function readProperty(
	value: unknown,
	key: string,
	state?: ReflectionState,
): unknown {
	if (
		value === null ||
		(typeof value !== 'object' && typeof value !== 'function')
	) {
		return undefined
	}

	try {
		// SAFETY: the boundary check above proves property access is valid. The
		// result stays unknown until a closed allowlist accepts it.
		return (value as Record<string, unknown>)[key]
	} catch {
		if (state) state.failed = true
		return undefined
	}
}

function toSafeAuthErrorType(value: unknown): SafeAuthErrorType {
	switch (value) {
		case 'AccessDenied':
		case 'AccountNotLinked':
		case 'AdapterError':
		case 'AuthError':
		case 'CallbackRouteError':
		case 'EmailSignInError':
		case 'EventError':
		case 'InvalidCallbackUrl':
		case 'InvalidCheck':
		case 'InvalidEndpoints':
		case 'InvalidProvider':
		case 'JWTSessionError':
		case 'MissingAdapter':
		case 'MissingAdapterMethods':
		case 'MissingCSRF':
		case 'MissingSecret':
		case 'OAuthAccountNotLinked':
		case 'OAuthCallbackError':
		case 'OAuthProfileParseError':
		case 'OAuthSignInError':
		case 'SessionTokenError':
		case 'SignOutError':
		case 'UntrustedHost':
		case 'Verification':
			return value
		default:
			return 'unknown'
	}
}

function toSafeAuthErrorKind(value: unknown): SafeAuthErrorKind {
	return value === 'error' || value === 'signIn' ? value : 'unknown'
}

function toSafeAuthProvider(value: unknown): SafeAuthProvider {
	return value === 'discord' || value === 'github' || value === 'postmark'
		? value
		: 'unknown'
}

function toSafeAuthCauseCode(value: unknown): SafeAuthCauseCode {
	switch (value) {
		case 'EAI_AGAIN':
		case 'ECONNREFUSED':
		case 'ECONNRESET':
		case 'ENOTFOUND':
		case 'ETIMEDOUT':
		case 'UND_ERR_CONNECT_TIMEOUT':
		case 'access_denied':
		case 'invalid_grant':
		case 'invalid_request':
		case 'server_error':
		case 'temporarily_unavailable':
			return value
		default:
			return 'unknown'
	}
}

function toSafeCauseCategory(
	value: unknown,
	state: ReflectionState,
): SafeAuthCauseCategory {
	try {
		if (value instanceof AggregateError) return 'aggregate-error'
		if (value instanceof TypeError) return 'type-error'
		if (value instanceof RangeError) return 'range-error'
		if (value instanceof ReferenceError) return 'reference-error'
		if (value instanceof SyntaxError) return 'syntax-error'
		if (value instanceof Error) {
			return toSafeAuthErrorType(readProperty(value, 'type', state)) ===
				'unknown'
				? 'error'
				: 'auth-error'
		}
		return 'unknown'
	} catch {
		state.failed = true
		return 'unknown'
	}
}

function readAuthCause(error: unknown, state: ReflectionState): unknown {
	return readProperty(readProperty(error, 'cause', state), 'err', state)
}

function classifyAuthFailure(type: SafeAuthErrorType): AuthFailureKind {
	switch (type) {
		case 'OAuthAccountNotLinked':
		case 'AccountNotLinked':
			return 'account-not-linked'
		case 'AdapterError':
			return 'adapter-failure'
		case 'CallbackRouteError':
			return 'callback-failure'
		case 'Verification':
			return 'magic-link-invalid'
		case 'OAuthCallbackError':
			return 'oauth-callback-failure'
		case 'OAuthProfileParseError':
		case 'OAuthSignInError':
			return 'oauth-signin-failure'
		case 'EmailSignInError':
			return 'email-signin-failure'
		case 'AccessDenied':
		case 'MissingCSRF':
			return 'sign-in-denied'
		case 'InvalidEndpoints':
		case 'InvalidProvider':
		case 'MissingAdapter':
		case 'MissingAdapterMethods':
		case 'MissingSecret':
		case 'UntrustedHost':
			return 'configuration-failure'
		case 'AuthError':
		case 'EventError':
		case 'InvalidCallbackUrl':
		case 'InvalidCheck':
		case 'JWTSessionError':
		case 'SessionTokenError':
		case 'SignOutError':
		case 'unknown':
			return 'unknown-failure'
	}
}

function toOAuthCallbackResultCode(value: unknown): OAuthCallbackResultCode {
	switch (value) {
		case 'access_denied':
		case 'invalid_request':
		case 'server_error':
		case 'temporarily_unavailable':
			return value
		default:
			return 'unknown'
	}
}

function classifyOAuthCallbackFailure(
	code: OAuthCallbackResultCode,
): OAuthCallbackFailureKind {
	switch (code) {
		case 'access_denied':
			return 'user-denied'
		case 'server_error':
		case 'temporarily_unavailable':
			return 'provider-unavailable'
		case 'invalid_request':
			return 'invalid-request'
		case 'unknown':
			return 'unknown-oauth-failure'
	}
}

/**
 * Auth.js stores most callback causes under `error.cause.err`. Every retained
 * value passes through a closed allowlist. Unknown strings never reach logs.
 */
export function getAuthErrorLogData(error: unknown): AuthErrorLogData {
	try {
		const state: ReflectionState = { failed: false }
		const authErrorType = toSafeAuthErrorType(
			readProperty(error, 'type', state),
		)
		const causeContainer = readProperty(error, 'cause', state)
		const cause = readAuthCause(error, state)
		const data: AuthErrorLogData = {
			authErrorType,
			authErrorKind: toSafeAuthErrorKind(readProperty(error, 'kind', state)),
			authCauseType: toSafeAuthErrorType(readProperty(cause, 'type', state)),
			authCauseCategory: toSafeCauseCategory(cause, state),
			authCauseCode: toSafeAuthCauseCode(readProperty(cause, 'code', state)),
			authFailureKind: classifyAuthFailure(authErrorType),
			provider: toSafeAuthProvider(
				readProperty(causeContainer, 'provider', state) ??
					readProperty(causeContainer, 'providerId', state),
			),
		}
		return state.failed ? createAllUnknownAuthErrorLogData() : data
	} catch {
		return createAllUnknownAuthErrorLogData()
	}
}

/**
 * Auth.js 0.37 emits OAuth provider response details through logger.debug,
 * then drops them from the OAuthCallbackError instance. Keep only the fixed
 * debug event, provider allowlist, and OAuth result-code allowlist.
 */
export function getOAuthCallbackDebugLogData(
	message: unknown,
	metadata: unknown,
): OAuthCallbackLogData | null {
	if (message !== 'OAuthCallbackError') return null

	try {
		const state: ReflectionState = { failed: false }
		const oauthResultCode = toOAuthCallbackResultCode(
			readProperty(metadata, 'error', state),
		)
		const data: OAuthCallbackLogData = {
			authFailureKind: classifyOAuthCallbackFailure(oauthResultCode),
			oauthResultCode,
			provider: toSafeAuthProvider(readProperty(metadata, 'providerId', state)),
		}
		return state.failed ? createAllUnknownOAuthCallbackLogData() : data
	} catch {
		return createAllUnknownOAuthCallbackLogData()
	}
}

export function getAuthWarningLogData(code: unknown): {
	code: SafeAuthWarningCode
} {
	switch (code) {
		case 'csrf-disabled':
		case 'env-url-basepath-mismatch':
		case 'env-url-basepath-redundant':
			return { code }
		default:
			return { code: 'unknown' }
	}
}

/** Generic AccessDenied can wrap callback infrastructure failures. Keep it loud. */
export function getNextAuthErrorLogLevel(_error: unknown): 'info' | 'error' {
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
