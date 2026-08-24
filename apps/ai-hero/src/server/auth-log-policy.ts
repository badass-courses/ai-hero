type SafeAuthErrorType =
	| 'AccessDenied'
	| 'AdapterError'
	| 'CallbackRouteError'
	| 'OAuthCallbackError'
	| 'OAuthAccountNotLinked'
	| 'unknown'

type SafeOAuthProvider = 'discord' | 'github' | 'unknown'
type SafeOAuthResultCode =
	| 'access_denied'
	| 'invalid_request'
	| 'server_error'
	| 'temporarily_unavailable'
	| 'unknown'

type OAuthCallbackReasonCode =
	| 'provider-cancelled'
	| 'invalid-request'
	| 'provider-unavailable'
	| 'unknown-oauth-failure'

function readProperty(value: unknown, key: string): unknown {
	if ((typeof value !== 'object' && typeof value !== 'function') || !value) {
		return undefined
	}
	return Reflect.get(value, key)
}

function toSafeAuthErrorType(value: unknown): SafeAuthErrorType {
	switch (value) {
		case 'AccessDenied':
		case 'AdapterError':
		case 'CallbackRouteError':
		case 'OAuthCallbackError':
		case 'OAuthAccountNotLinked':
			return value
		default:
			return 'unknown'
	}
}

function toSafeProvider(value: unknown): SafeOAuthProvider {
	return value === 'discord' || value === 'github' ? value : 'unknown'
}

function toSafeOAuthResultCode(value: unknown): SafeOAuthResultCode {
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

function toOAuthCallbackReasonCode(
	resultCode: SafeOAuthResultCode,
): OAuthCallbackReasonCode {
	switch (resultCode) {
		case 'access_denied':
			return 'provider-cancelled'
		case 'invalid_request':
			return 'invalid-request'
		case 'server_error':
		case 'temporarily_unavailable':
			return 'provider-unavailable'
		default:
			return 'unknown-oauth-failure'
	}
}

export function getSafeAuthErrorLogData(error: unknown): {
	errorType: SafeAuthErrorType
	reasonCode:
		| 'access-denied'
		| 'oauth-account-not-linked'
		| 'oauth-callback-failed'
		| 'adapter-failed'
		| 'auth-failed'
} {
	try {
		const errorType = toSafeAuthErrorType(
			readProperty(error, 'type') ?? readProperty(error, 'name'),
		)
		switch (errorType) {
			case 'AccessDenied':
				return { errorType, reasonCode: 'access-denied' }
			case 'OAuthAccountNotLinked':
				return { errorType, reasonCode: 'oauth-account-not-linked' }
			case 'OAuthCallbackError':
				return { errorType, reasonCode: 'oauth-callback-failed' }
			case 'AdapterError':
				return { errorType, reasonCode: 'adapter-failed' }
			default:
				return { errorType, reasonCode: 'auth-failed' }
		}
	} catch {
		return { errorType: 'unknown', reasonCode: 'auth-failed' }
	}
}

/**
 * Auth.js emits provider callback details through logger.debug, then omits
 * them from OAuthCallbackError. Retain only fixed provider and result codes.
 */
export function getOAuthCallbackLogData(
	message: unknown,
	metadata: unknown,
): {
	provider: SafeOAuthProvider
	reasonCode: OAuthCallbackReasonCode
	oauthResultCode: SafeOAuthResultCode
} | null {
	if (message !== 'OAuthCallbackError') return null
	try {
		const oauthResultCode = toSafeOAuthResultCode(
			readProperty(metadata, 'error'),
		)
		return {
			provider: toSafeProvider(readProperty(metadata, 'providerId')),
			reasonCode: toOAuthCallbackReasonCode(oauthResultCode),
			oauthResultCode,
		}
	} catch {
		return {
			provider: 'unknown',
			reasonCode: 'unknown-oauth-failure',
			oauthResultCode: 'unknown',
		}
	}
}

/** Generic AccessDenied can wrap callback infrastructure failures. Keep it loud. */
export function getNextAuthErrorLogLevel(
	_error: unknown,
): 'info' | 'error' {
	return 'error'
}
