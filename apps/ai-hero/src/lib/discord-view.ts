export type DiscordRolesView =
	| 'connect'
	| 'fetch-error'
	| 'no-roles'
	| 'needs-sync'
	| 'all-assigned'

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
	'No course roles yet. If you have access to a cohort or workshop, contact support.'

export const FETCH_ERROR_COPY =
	"We couldn't check your Discord roles just now. Try again in a moment."

// Real stored values: EntitlementSourceType in lib/entitlements.ts
const SOURCE_LABELS: Record<string, string> = {
	purchase: 'Purchase',
	subscription: 'Subscription',
	coupon: 'Coupon or team seat',
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

/** The user has a Discord account row. Role sync and the invite use the bot, not the user's token. */
export function hasDiscordAccount(
	account: { provider?: string } | null | undefined,
): boolean {
	return account?.provider === 'discord'
}

/**
 * Fully connected: a Discord account with a usable OAuth token. Joining the
 * server on link (guilds.join) needs the token, so a tokenless account must
 * reconnect. Shared by /discord and the welcome page.
 */
export function isDiscordConnected(
	account:
		| { provider?: string; access_token?: string | null }
		| null
		| undefined,
): boolean {
	return hasDiscordAccount(account) && Boolean(account?.access_token)
}

export type MemberClassification =
	| { kind: 'member'; roles: string[]; username: string | null }
	| { kind: 'not-member' }
	| { kind: 'error' }

const UNKNOWN_MEMBER_CODE = 10007

/**
 * Classify a Discord guild member lookup, whether it returned a body or threw.
 * Only "not in the server" is a normal state; everything else is an error.
 */
export function classifyMemberResponse(
	outcome: { result: unknown } | { thrown: unknown },
): MemberClassification {
	if ('thrown' in outcome) {
		const status = (outcome.thrown as { status?: unknown } | null)?.status
		return status === 404 ? { kind: 'not-member' } : { kind: 'error' }
	}
	const body = outcome.result as Record<string, unknown> | null | undefined
	if (!body || typeof body !== 'object') return { kind: 'error' }
	const user = body.user
	if (user && typeof user === 'object' && Array.isArray(body.roles)) {
		const username = (user as { username?: unknown }).username
		return {
			kind: 'member',
			roles: body.roles.filter((r): r is string => typeof r === 'string'),
			username: typeof username === 'string' ? username : null,
		}
	}
	return body.code === UNKNOWN_MEMBER_CODE
		? { kind: 'not-member' }
		: { kind: 'error' }
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
	if (typeof code !== 'string' || !code) return GENERIC_DISCORD_ERROR
	return Object.hasOwn(DISCORD_ERROR_MESSAGES, code)
		? DISCORD_ERROR_MESSAGES[code as DiscordErrorCode]
		: GENERIC_DISCORD_ERROR
}
