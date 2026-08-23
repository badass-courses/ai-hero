const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token'
const MAX_REFRESH_ATTEMPTS = 3
const RETRY_DELAYS_MS = [100, 250] as const

type DiscordTokenResponse = {
	ok: boolean
	status: number
	json: () => Promise<unknown>
}

type FetchDiscordToken = (
	url: string,
	init: RequestInit,
) => Promise<DiscordTokenResponse>

type DiscordRefreshResult =
	| {
			status: 'refreshed'
			accessToken: string
			refreshToken: string
			expiresIn: number
			attempts: number
	  }
	| {
			status: 'reconnect-required'
			reasonCode: 'invalid-grant' | 'missing-refresh-token'
			attempts: number
	  }
	| {
			status: 'failed'
			reasonCode:
				| 'invalid-request'
				| 'client-auth-failed'
				| 'unsupported-grant-type'
				| 'invalid-scope'
				| 'provider-rejected'
				| 'invalid-response'
				| 'configuration-error'
				| 'retry-exhausted'
			attempts: number
			lastStatus: number | null
	  }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOAuthErrorCode(value: unknown): string | null {
	if (!isRecord(value) || typeof value.error !== 'string') return null
	switch (value.error) {
		case 'invalid_grant':
		case 'invalid_request':
		case 'invalid_client':
		case 'unsupported_grant_type':
		case 'invalid_scope':
		case 'server_error':
		case 'temporarily_unavailable':
			return value.error
		default:
			return null
	}
}

function permanentFailureReason(
	errorCode: string | null,
): Exclude<
	Extract<DiscordRefreshResult, { status: 'failed' }>['reasonCode'],
	'invalid-response' | 'retry-exhausted'
> {
	switch (errorCode) {
		case 'invalid_request':
			return 'invalid-request'
		case 'invalid_client':
			return 'client-auth-failed'
		case 'unsupported_grant_type':
			return 'unsupported-grant-type'
		case 'invalid_scope':
			return 'invalid-scope'
		default:
			return 'provider-rejected'
	}
}

function isTransientStatus(status: number) {
	return status === 408 || status === 425 || status === 429 || status >= 500
}

function parseSuccessfulResponse(
	value: unknown,
	currentRefreshToken: string,
): Omit<Extract<DiscordRefreshResult, { status: 'refreshed' }>, 'attempts'> | null {
	if (
		!isRecord(value) ||
		typeof value.access_token !== 'string' ||
		value.access_token.length === 0 ||
		typeof value.expires_in !== 'number' ||
		!Number.isFinite(value.expires_in) ||
		value.expires_in <= 0
	) {
		return null
	}

	return {
		status: 'refreshed',
		accessToken: value.access_token,
		refreshToken:
			typeof value.refresh_token === 'string' && value.refresh_token.length > 0
				? value.refresh_token
				: currentRefreshToken,
		expiresIn: value.expires_in,
	}
}

const defaultSleep = (delayMs: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, delayMs))

export function getDiscordRefreshAccountUpdate(
	result: DiscordRefreshResult,
	nowSeconds: number,
) {
	switch (result.status) {
		case 'refreshed':
			return {
				access_token: result.accessToken,
				expires_at: Math.floor(nowSeconds + result.expiresIn),
				refresh_token: result.refreshToken,
			}
		case 'reconnect-required':
			return {
				access_token: null,
				expires_at: null,
				refresh_token: null,
			}
		case 'failed':
			return null
	}
}

export async function refreshDiscordAccessToken({
	clientId,
	clientSecret,
	refreshToken,
	fetchToken = fetch,
	sleep = defaultSleep,
}: {
	clientId: string | undefined
	clientSecret: string | undefined
	refreshToken: string | null
	fetchToken?: FetchDiscordToken
	sleep?: (delayMs: number) => Promise<void>
}): Promise<DiscordRefreshResult> {
	if (!clientId || !clientSecret) {
		return {
			status: 'failed',
			reasonCode: 'configuration-error',
			attempts: 0,
			lastStatus: null,
		}
	}
	if (!refreshToken) {
		return {
			status: 'reconnect-required',
			reasonCode: 'missing-refresh-token',
			attempts: 0,
		}
	}

	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	})
	let lastStatus: number | null = null

	for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt += 1) {
		try {
			const response = await fetchToken(DISCORD_TOKEN_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			})
			lastStatus = response.status
			const responseBody = await response.json().catch(() => null)

			if (response.ok) {
				const refreshed = parseSuccessfulResponse(responseBody, refreshToken)
				return refreshed
					? { ...refreshed, attempts: attempt }
					: {
							status: 'failed',
							reasonCode: 'invalid-response',
							attempts: attempt,
							lastStatus,
						}
			}

			const errorCode = readOAuthErrorCode(responseBody)
			if (response.status === 400 && errorCode === 'invalid_grant') {
				return {
					status: 'reconnect-required',
					reasonCode: 'invalid-grant',
					attempts: attempt,
				}
			}
			const isTransientFailure =
				isTransientStatus(response.status) ||
				errorCode === 'server_error' ||
				errorCode === 'temporarily_unavailable'
			if (!isTransientFailure) {
				return {
					status: 'failed',
					reasonCode: permanentFailureReason(errorCode),
					attempts: attempt,
					lastStatus,
				}
			}
		} catch {
			lastStatus = null
		}

		if (attempt < MAX_REFRESH_ATTEMPTS) {
			await sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!)
		}
	}

	return {
		status: 'failed',
		reasonCode: 'retry-exhausted',
		attempts: MAX_REFRESH_ATTEMPTS,
		lastStatus,
	}
}
