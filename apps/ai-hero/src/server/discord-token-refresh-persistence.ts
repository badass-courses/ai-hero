import {
	getDiscordRefreshAccountUpdate,
	type DiscordRefreshResult,
} from './discord-token-refresh'

export type DiscordAccountCredentials = {
	accessToken: string | null
	refreshToken: string | null
	expiresAt: number | null
}

export type DiscordCredentialUpdate = Partial<DiscordAccountCredentials>

/** Covers the six-second provider budget plus database persistence/readback. */
export const DISCORD_REFRESH_CLAIM_LEASE_MS = 30_000

export function getDiscordRefreshClaimExpiresAt(nowMs = Date.now()) {
	return Math.ceil((nowMs + DISCORD_REFRESH_CLAIM_LEASE_MS) / 1000)
}

export function isDiscordTokenExpired(
	expiresAt: number | null,
	nowMs = Date.now(),
) {
	return expiresAt !== null && expiresAt * 1000 < nowMs
}

type ProviderOutcome = DiscordRefreshResult['status']
type DatabaseOutcome =
	| 'claim-applied'
	| 'claim-stale'
	| 'write-applied'
	| 'write-stale'
	| 'success-recovered'
	| 'readback-mismatch'
	| 'account-missing'
	| 'database-error'

export type DiscordRefreshClaimResult =
	| { status: 'claimed'; databaseOutcome: 'claim-applied' }
	| {
			status: 'stale-result'
			databaseOutcome: Exclude<
				DatabaseOutcome,
				| 'claim-applied'
				| 'write-applied'
				| 'write-stale'
				| 'success-recovered'
			>
	  }

export type DiscordRefreshPersistenceResult = {
	action:
		| 'refreshed'
		| 'reconnect-required'
		| 'failed'
		| 'stale-result'
	providerOutcome: ProviderOutcome
	databaseOutcome: Exclude<DatabaseOutcome, 'claim-applied' | 'claim-stale'>
}

function credentialsMatch(
	left: DiscordAccountCredentials,
	right: DiscordAccountCredentials,
) {
	return (
		left.accessToken === right.accessToken &&
		left.refreshToken === right.refreshToken &&
		left.expiresAt === right.expiresAt
	)
}

function areCredentialsCleared(credentials: DiscordAccountCredentials) {
	return (
		credentials.accessToken === null &&
		credentials.refreshToken === null &&
		credentials.expiresAt === null
	)
}

async function safeRead(
	read: () => Promise<DiscordAccountCredentials | null>,
): Promise<
	| { status: 'read'; credentials: DiscordAccountCredentials | null }
	| { status: 'database-error' }
> {
	try {
		return { status: 'read', credentials: await read() }
	} catch {
		return { status: 'database-error' }
	}
}

export async function claimDiscordRefresh({
	expected,
	claimExpiresAt,
	claim,
	read,
}: {
	expected: DiscordAccountCredentials
	claimExpiresAt: number
	claim: () => Promise<number>
	read: () => Promise<DiscordAccountCredentials | null>
}): Promise<DiscordRefreshClaimResult> {
	let rowsAffected: number
	try {
		rowsAffected = await claim()
	} catch {
		return { status: 'stale-result', databaseOutcome: 'database-error' }
	}
	if (rowsAffected !== 1) {
		return { status: 'stale-result', databaseOutcome: 'claim-stale' }
	}

	const readback = await safeRead(read)
	if (readback.status === 'database-error') {
		return { status: 'stale-result', databaseOutcome: 'database-error' }
	}
	if (!readback.credentials) {
		return { status: 'stale-result', databaseOutcome: 'account-missing' }
	}
	if (
		readback.credentials.refreshToken !== expected.refreshToken ||
		readback.credentials.expiresAt !== claimExpiresAt
	) {
		return { status: 'stale-result', databaseOutcome: 'readback-mismatch' }
	}

	return { status: 'claimed', databaseOutcome: 'claim-applied' }
}

function getCredentialUpdate(
	result: DiscordRefreshResult,
	expected: DiscordAccountCredentials,
	nowSeconds: number,
): DiscordCredentialUpdate {
	const accountUpdate = getDiscordRefreshAccountUpdate(result, nowSeconds)
	if (accountUpdate) {
		return {
			accessToken: accountUpdate.access_token,
			refreshToken: accountUpdate.refresh_token,
			expiresAt: accountUpdate.expires_at,
		}
	}
	return { expiresAt: expected.expiresAt }
}

function getExpectedCredentials(
	result: DiscordRefreshResult,
	expected: DiscordAccountCredentials,
	update: DiscordCredentialUpdate,
): DiscordAccountCredentials {
	if (result.status === 'failed') return expected
	return {
		accessToken: update.accessToken ?? null,
		refreshToken: update.refreshToken ?? null,
		expiresAt: update.expiresAt ?? null,
	}
}

function appliedAction(result: DiscordRefreshResult) {
	switch (result.status) {
		case 'refreshed':
			return 'refreshed' as const
		case 'reconnect-required':
			return 'reconnect-required' as const
		case 'failed':
			return 'failed' as const
	}
}

export async function persistDiscordRefreshResult({
	result,
	expected,
	nowSeconds,
	writeClaimed,
	recoverCleared,
	read,
}: {
	result: DiscordRefreshResult
	expected: DiscordAccountCredentials
	nowSeconds: number
	writeClaimed: (update: DiscordCredentialUpdate) => Promise<number>
	recoverCleared: (update: DiscordCredentialUpdate) => Promise<number>
	read: () => Promise<DiscordAccountCredentials | null>
}): Promise<DiscordRefreshPersistenceResult> {
	const providerOutcome = result.status
	const update = getCredentialUpdate(result, expected, nowSeconds)
	const expectedCredentials = getExpectedCredentials(result, expected, update)
	let rowsAffected: number
	try {
		rowsAffected = await writeClaimed(update)
	} catch {
		return {
			action: 'stale-result',
			providerOutcome,
			databaseOutcome: 'database-error',
		}
	}

	let readback = await safeRead(read)
	if (readback.status === 'database-error') {
		return {
			action: 'stale-result',
			providerOutcome,
			databaseOutcome: 'database-error',
		}
	}
	if (!readback.credentials) {
		return {
			action: 'stale-result',
			providerOutcome,
			databaseOutcome: 'account-missing',
		}
	}

	if (rowsAffected === 1) {
		return credentialsMatch(readback.credentials, expectedCredentials)
			? {
					action: appliedAction(result),
					providerOutcome,
					databaseOutcome: 'write-applied',
				}
			: {
					action: 'stale-result',
					providerOutcome,
					databaseOutcome: 'readback-mismatch',
				}
	}

	if (result.status === 'refreshed' && areCredentialsCleared(readback.credentials)) {
		let recoveredRows: number
		try {
			recoveredRows = await recoverCleared(update)
		} catch {
			return {
				action: 'stale-result',
				providerOutcome,
				databaseOutcome: 'database-error',
			}
		}
		readback = await safeRead(read)
		if (readback.status === 'database-error') {
			return {
				action: 'stale-result',
				providerOutcome,
				databaseOutcome: 'database-error',
			}
		}
		if (
			recoveredRows === 1 &&
			readback.credentials &&
			credentialsMatch(readback.credentials, expectedCredentials)
		) {
			return {
				action: 'refreshed',
				providerOutcome,
				databaseOutcome: 'success-recovered',
			}
		}
	}

	return {
		action: 'stale-result',
		providerOutcome,
		databaseOutcome: 'write-stale',
	}
}
