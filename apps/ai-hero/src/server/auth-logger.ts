import {
	getNextAuthErrorLogLevel,
	getOAuthCallbackLogData,
	getSafeAuthErrorLogData,
} from '@/server/auth-log-policy'
import { log } from '@/server/logger'

type AuthLogSink = {
	info: (event: string, data: Record<string, unknown>) => unknown
	warn: (event: string, data: Record<string, unknown>) => unknown
	error: (event: string, data: Record<string, unknown>) => unknown
}

function writeSafely(write: () => unknown): void {
	try {
		void Promise.resolve(write()).catch(() => undefined)
	} catch {
		// Authentication and recovery cannot depend on the log sink.
	}
}

function getSafeWarningCode(value: unknown) {
	switch (value) {
		case 'csrf-disabled':
		case 'env-url-basepath-mismatch':
		case 'env-url-basepath-redundant':
			return value
		default:
			return 'unknown'
	}
}

export function createSafeAuthLogger(sink: AuthLogSink) {
	return {
		error: (error: unknown): void => {
			const data = getSafeAuthErrorLogData(error)
			writeSafely(() =>
				getNextAuthErrorLogLevel(error) === 'info'
					? sink.info('auth.nextauth.expected', data)
					: sink.error('auth.nextauth.error', data),
			)
		},
		warn: (code: unknown): void => {
			writeSafely(() =>
				sink.warn('auth.nextauth.warn', { code: getSafeWarningCode(code) }),
			)
		},
		debug: (message: unknown, metadata?: unknown): void => {
			const data = getOAuthCallbackLogData(message, metadata)
			if (!data) return
			writeSafely(() =>
				data.reasonCode === 'provider-cancelled'
					? sink.warn('auth.nextauth.oauth-callback', data)
					: sink.error('auth.nextauth.oauth-callback', data),
			)
		},
	}
}

export const authLogger = createSafeAuthLogger({
	info: (event, data) => log.info(event, data),
	warn: (event, data) => log.warn(event, data),
	error: (event, data) => log.error(event, data),
})
