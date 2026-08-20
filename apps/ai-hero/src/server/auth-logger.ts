import {
	getAuthErrorLogData,
	getAuthWarningLogData,
	getNextAuthErrorLogLevel,
	getOAuthCallbackDebugLogData,
} from '@/server/auth-log-policy'
import { log } from '@/server/logger'

type AuthLogSink = {
	info: (event: string, data: Record<string, unknown>) => unknown
	warn: (event: string, data: Record<string, unknown>) => unknown
	error: (event: string, data: Record<string, unknown>) => unknown
}

const ALL_UNKNOWN_AUTH_ERROR_LOG_DATA = {
	authErrorType: 'unknown',
	authErrorKind: 'unknown',
	authCauseType: 'unknown',
	authCauseCategory: 'unknown',
	authCauseCode: 'unknown',
	authFailureKind: 'unknown-failure',
	provider: 'unknown',
} as const

const ALL_UNKNOWN_OAUTH_CALLBACK_LOG_DATA = {
	authFailureKind: 'unknown-oauth-failure',
	oauthResultCode: 'unknown',
	provider: 'unknown',
} as const

/** Keep synchronous throws, rejected promises, and hostile thenables out of auth. */
export function runLogSinkSafely(write: () => unknown): void {
	try {
		void Promise.resolve(write()).catch(() => undefined)
	} catch {
		// Auth recovery and redirects must not depend on observability availability.
	}
}

export function createSafeAuthLogger(sink: AuthLogSink) {
	return {
		error: (error: unknown): void => {
			try {
				let data: Record<string, unknown> = ALL_UNKNOWN_AUTH_ERROR_LOG_DATA
				let level: 'info' | 'error' = 'error'
				try {
					data = getAuthErrorLogData(error)
					level = getNextAuthErrorLogLevel(error)
				} catch {
					// Keep the fixed all-unknown record.
				}

				runLogSinkSafely(() =>
					level === 'info'
						? sink.info('auth.nextauth.expected', data)
						: sink.error('auth.nextauth.error', data),
				)
			} catch {
				// The configured Auth.js callback must be total.
			}
		},
		warn: (code: unknown): void => {
			try {
				let data: Record<string, unknown> = { code: 'unknown' }
				try {
					data = getAuthWarningLogData(code)
				} catch {
					// Keep the fixed unknown warning code.
				}
				runLogSinkSafely(() => sink.warn('auth.nextauth.warn', data))
			} catch {
				// The configured Auth.js callback must be total.
			}
		},
		debug: (message: unknown, metadata?: unknown): void => {
			try {
				let data: Record<string, unknown> | null = null
				try {
					data = getOAuthCallbackDebugLogData(message, metadata)
				} catch {
					data =
						message === 'OAuthCallbackError'
							? ALL_UNKNOWN_OAUTH_CALLBACK_LOG_DATA
							: null
				}
				if (!data) return

				runLogSinkSafely(() =>
					data.authFailureKind === 'user-denied'
						? sink.warn('auth.nextauth.oauth_callback', data)
						: sink.error('auth.nextauth.oauth_callback', data),
				)
			} catch {
				// The configured Auth.js callback must be total.
			}
		},
	}
}

export const authLogger = createSafeAuthLogger({
	info: (event, data) => log.info(event, data),
	warn: (event, data) => log.warn(event, data),
	error: (event, data) => log.error(event, data),
})
