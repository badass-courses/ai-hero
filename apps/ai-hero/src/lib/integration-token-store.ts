import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import {
	decryptIntegrationToken,
	encryptIntegrationToken,
	integrationTokenKey,
	type IntegrationTokenProvider,
} from './integration-token-crypto'

// Never serialize driver errors: their SQL, parameters and causes may contain
// tokens or ciphertext. Only static, value-free fields are logged.
async function reason(
	provider: IntegrationTokenProvider,
	operation: 'read' | 'write',
	code: string,
) {
	try {
		await log[code === 'no-key' ? 'debug' : 'warn'](
			operation === 'read'
				? 'integration-token.missing'
				: 'integration-token.write-failed',
			{ provider, operation, reason: code },
		)
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
): Promise<string | undefined> {
	if (!env.INTEGRATION_TOKEN_KEY) {
		await reason(provider, 'read', 'no-key')
		return undefined
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
			return undefined
		}
		try {
			return decryptIntegrationToken(provider, row, key)
		} catch {
			await reason(provider, 'read', 'decrypt-failed')
			return undefined
		}
	} catch (error) {
		await reason(
			provider,
			'read',
			missingTable(error) ? 'no-table' : 'read-failed',
		)
		return undefined
	}
}

export type IntegrationTokenPutResult = { ok: true } | { ok: false }

// Static, value-free operator copy for OAuth callback result pages.
export function integrationTokenStorageNotice(
	result: IntegrationTokenPutResult,
): string | null {
	if (result.ok) return null
	return 'The refresh token could not be saved to the token store. Check the server configuration and authorize again.'
}

export async function putIntegrationRefreshToken(
	provider: IntegrationTokenProvider,
	token: string,
): Promise<IntegrationTokenPutResult> {
	if (!env.INTEGRATION_TOKEN_KEY) {
		await reason(provider, 'write', 'no-key')
		return { ok: false }
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
		return { ok: true }
	} catch (error) {
		await reason(
			provider,
			'write',
			missingTable(error) ? 'no-table' : 'write-failed',
		)
		return { ok: false }
	}
}
