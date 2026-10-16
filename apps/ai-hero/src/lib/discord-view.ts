export type DiscordRolesView =
	'connect' | 'fetch-error' | 'no-roles' | 'needs-sync' | 'all-assigned'

export type MemberFetch = 'ok' | 'error'

/**
 * What the roles page should show. Order matters: a failed Discord lookup
 * says nothing about assignment, so it never reads as "needs sync".
 */
export function discordRolesView({
	roles,
	memberFetch,
	connected,
}: {
	roles: ReadonlyArray<{ assigned: boolean }>
	memberFetch: MemberFetch
	connected: boolean
}): DiscordRolesView {
	if (!connected) return 'connect'
	if (memberFetch === 'error') return 'fetch-error'
	if (roles.length === 0) return 'no-roles'
	return roles.every((r) => r.assigned) ? 'all-assigned' : 'needs-sync'
}

export const NO_ROLES_COPY =
	'No course roles yet. If you have access to a cohort or workshop, use Sync roles or contact support.'

export const FETCH_ERROR_COPY =
	"We couldn't check your Discord roles just now. Try again in a moment."

const SOURCE_LABELS: Record<string, string> = {
	purchase: 'Purchase',
	coupon: 'Coupon',
	bulk_redeem: 'Team seat',
	comp: 'Complimentary access',
	manual: 'Added by support',
}

/** Human label for an entitlement source; unknown sources stay generic. */
export function sourceLabel(source: string | null | undefined): string {
	const key = source?.toLowerCase()
	if (!key) return 'Course access'
	return Object.hasOwn(SOURCE_LABELS, key)
		? SOURCE_LABELS[key]!
		: 'Course access'
}

/** A Discord account row is connected: sync and the invite never use the OAuth token. */
export function isDiscordConnected(
	account: { provider?: string } | null | undefined,
): boolean {
	return Boolean(account)
}

export const DISCORD_ERROR_CODES = ['not-linked'] as const
export type DiscordErrorCode = (typeof DISCORD_ERROR_CODES)[number]

export const DISCORD_ERROR_MESSAGES: Record<DiscordErrorCode, string> = {
	'not-linked': 'Discord account was not linked. Please try again.',
}

export const GENERIC_DISCORD_ERROR =
	'Something went wrong connecting Discord. Please try again.'

/** Fixed copy for a `?error=` value. Raw query text never reaches the page. */
export function discordErrorMessage(code: string | null | undefined): string {
	if (!code) return GENERIC_DISCORD_ERROR
	return Object.hasOwn(DISCORD_ERROR_MESSAGES, code)
		? DISCORD_ERROR_MESSAGES[code as DiscordErrorCode]
		: GENERIC_DISCORD_ERROR
}
