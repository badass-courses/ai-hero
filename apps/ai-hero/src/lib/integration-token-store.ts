import { env } from '@/env.mjs'
import { log, serializeError } from '@/server/logger'
import {
	decryptIntegrationToken,
	encryptIntegrationToken,
	integrationTokenKey,
	type IntegrationTokenProvider,
} from './integration-token-crypto'

// Never serialize driver errors: their SQL, parameters and causes may contain
// tokens or ciphertext. Only a newly constructed, value-free reason is logged.
async function reason(
	provider: IntegrationTokenProvider,
	operation: 'read' | 'write',
	code: string,
) {
	try {
		await log.warn('integration-token.fallback', {
			provider,
			operation,
			reason: code,
			error: serializeError(
				new Error(`Integration token ${operation}: ${code}`),
			),
		})
	} catch {
		/* Logging must not change OAuth outcomes. */
	}
}

function missingTable(error: unknown): boolean {
	const seen = new Set<unknown>()
	while (error && typeof error === 'object' && !seen.has(error)) {
		seen.add(error)
		const e = error as { code?: unknown; errno?: unknown; cause?: unknown }
		if (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146) return true
		error = e.cause
	}
	return false
}

export async function getIntegrationRefreshToken(
	provider: IntegrationTokenProvider,
	// Raw process.env readers retain their existing source, even when undefined.
	...fallbackOverride: [fallback?: string]
): Promise<string | undefined> {
	const fallback = fallbackOverride.length
		? fallbackOverride[0]
		: provider === 'dropbox'
			? env.DROPBOX_REFRESH_TOKEN
			: env.YOUTUBE_ANALYTICS_REFRESH_TOKEN
	if (!env.INTEGRATION_TOKEN_KEY) {
		await reason(provider, 'read', 'no-key')
		return fallback
	}
	try {
		const key = integrationTokenKey(env.INTEGRATION_TOKEN_KEY)
		const [{ db }, { integrationToken }, { eq }] = await Promise.all([
			import('@/db'),
			import('@/db/integration-token-schema'),
			import('drizzle-orm'),
		])
		const [row] = await db
			.select()
			.from(integrationToken)
			.where(eq(integrationToken.provider, provider))
			.limit(1)
		if (!row) {
			await reason(provider, 'read', 'no-row')
			return fallback
		}
		try {
			return decryptIntegrationToken(provider, row, key)
		} catch {
			await reason(provider, 'read', 'decrypt-failed')
			return fallback
		}
	} catch (error) {
		await reason(
			provider,
			'read',
			missingTable(error) ? 'no-table' : 'read-failed',
		)
		return fallback
	}
}

export async function putIntegrationRefreshToken(
	provider: IntegrationTokenProvider,
	token: string,
): Promise<void> {
	if (!env.INTEGRATION_TOKEN_KEY) {
		await reason(provider, 'write', 'no-key')
		return
	}
	try {
		const encrypted = encryptIntegrationToken(
			provider,
			token,
			integrationTokenKey(env.INTEGRATION_TOKEN_KEY),
		)
		const [{ db }, { integrationToken }] = await Promise.all([
			import('@/db'),
			import('@/db/integration-token-schema'),
		])
		const values = { ...encrypted, updatedAt: new Date() }
		await db
			.insert(integrationToken)
			.values({ provider, ...values })
			.onDuplicateKeyUpdate({ set: values })
	} catch (error) {
		await reason(
			provider,
			'write',
			missingTable(error) ? 'no-table' : 'write-failed',
		)
	}
}
