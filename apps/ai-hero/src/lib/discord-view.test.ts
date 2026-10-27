import { describe, expect, it } from 'vitest'

import { getDiscordAccessState } from '../app/discord/discord-access'
import {
	classifyMemberResponse,
	DISCORD_ERROR_CODES,
	DISCORD_ERROR_MESSAGES,
	discordErrorMessage,
	discordRolesView,
	FETCH_ERROR_COPY,
	GENERIC_DISCORD_ERROR,
	hasDiscordAccount,
	memberFetchFrom,
	showSyncButton,
	syncLookup,
	isDiscordConnected,
	sourceLabel,
	type DiscordRolesView,
	type MemberFetch,
} from './discord-view'

// The behavior before this change, modeled on the old page logic: no
// not-in-server state, and a failed lookup folded into "not a member".
const legacyRolesView = ({
	entitlements,
	linked,
	memberFetch,
}: {
	entitlements: { assigned: boolean }[]
	memberFetch: MemberFetch
	linked: boolean
}) => {
	if (!linked) return 'not-linked'
	if (memberFetch === 'error') return 'fetch-error'
	if (entitlements.length === 0) return 'no-roles'
	return entitlements.every((r) => r.assigned) ? 'in-sync' : 'needs-sync'
}
// Modeled on the old getDiscordAccessState tail (/discord) and the welcome page's check.
type Acct = { provider?: string; access_token?: string | null } | null
const legacyDiscordState = (account: Acct, linkResult?: string) => {
	if (account?.access_token) return 'linked'
	if (linkResult === 'expired') return 'expired'
	if (linkResult === 'denied') return 'denied'
	if (linkResult === 'account-conflict') return 'account-conflict'
	if (account) return 'reconnect-required'
	return 'ready'
}
const legacyWelcomeConnected = (a: Acct) => a !== null

const roleSets = {
	none: [],
	allAssigned: [{ assigned: true }, { assigned: true }],
	someAssigned: [{ assigned: true }, { assigned: false }],
	noneAssigned: [{ assigned: false }],
}

describe('discordRolesView truth table', () => {
	const fetches: MemberFetch[] = ['member', 'not-member', 'error']
	const cases: [
		keyof typeof roleSets,
		MemberFetch,
		boolean,
		DiscordRolesView,
	][] = []
	for (const linked of [true, false]) {
		for (const fetch of fetches) {
			for (const key of Object.keys(roleSets) as (keyof typeof roleSets)[]) {
				const expected: DiscordRolesView = !linked
					? 'not-linked'
					: fetch === 'error'
						? 'fetch-error'
						: key === 'none'
							? 'no-roles'
							: fetch === 'not-member'
								? 'not-in-server'
								: key === 'allAssigned'
									? 'in-sync'
									: 'needs-sync'
				cases.push([key, fetch, linked, expected])
			}
		}
	}

	it('covers every input combination', () => {
		expect(cases).toHaveLength(2 * 3 * 4)
	})

	it.each(cases)(
		'entitlements=%s fetch=%s linked=%s -> %s',
		(key, fetch, linked, expected) => {
			expect(
				discordRolesView({
					entitlements: roleSets[key],
					memberFetch: fetch,
					linked,
				}),
			).toBe(expected)
		},
	)

	// The brief's states as literal rows (linked, fetch, entitlements, view).
	const some = [{ assigned: false }]
	const done = [{ assigned: true }]
	it.each([
		[false, 'member', some, 'not-linked'],
		[true, 'not-member', some, 'not-in-server'],
		[true, 'error', some, 'fetch-error'],
		[true, 'member', done, 'in-sync'],
		[true, 'member', some, 'needs-sync'],
	] as const)(
		'brief row: linked=%s fetch=%s -> %s',
		(linked, memberFetch, entitlements, expected) => {
			expect(discordRolesView({ linked, memberFetch, entitlements })).toBe(
				expected,
			)
		},
	)

	it('Sync (needs-sync) is reachable only for a linked server member', () => {
		for (const [key, fetch, linked, expected] of cases) {
			if (expected === 'needs-sync') {
				expect(fetch).toBe('member')
				expect(linked).toBe(true)
				expect(key).not.toBe('none')
			}
		}
	})

	it('differs from the legacy view only for a linked user outside the server (legacy offered Sync there)', () => {
		const diffs = cases.filter(
			([key, fetch, linked]) =>
				legacyRolesView({
					entitlements: roleSets[key],
					memberFetch: fetch,
					linked,
				}) !==
				discordRolesView({
					entitlements: roleSets[key],
					memberFetch: fetch,
					linked,
				}),
		)
		expect(diffs.length).toBeGreaterThan(0)
		for (const [, fetch, linked, expected] of diffs) {
			expect(fetch).toBe('not-member')
			expect(linked).toBe(true)
			expect(expected).toBe('not-in-server')
		}
	})
})

describe('memberFetchFrom (lookup -> memberFetch)', () => {
	it.each([
		['thrown 500', { thrown: { status: 500 } }, 'error'],
		['thrown 404', { thrown: { status: 404 } }, 'not-member'],
		['thrown, no status', { thrown: new Error('boom') }, 'error'],
		['error body', { result: { code: 50001 } }, 'error'],
		['empty body', { result: null }, 'error'],
		['unknown member 10007', { result: { code: 10007 } }, 'not-member'],
		['member', { result: { user: { username: 'u' }, roles: [] } }, 'member'],
	] as const)('%s -> %s', (_name, outcome, expected) => {
		expect(memberFetchFrom(classifyMemberResponse(outcome as any))).toBe(
			expected,
		)
	})
})

describe('showSyncButton', () => {
	const views: DiscordRolesView[] = [
		'not-linked',
		'fetch-error',
		'no-roles',
		'not-in-server',
		'needs-sync',
		'in-sync',
	]
	it.each(views)('%s', (view) => {
		expect(showSyncButton(view)).toBe(view === 'needs-sync')
	})
})

describe('syncLookup (role sync member lookup)', () => {
	// Legacy: `'user' in body` on the raw body; a thrown lookup crashed the
	// action, and an error body read as "Not a member".
	const legacy = (body: Record<string, unknown>) =>
		'user' in body
			? 'proceed'
			: 'Not a member of the Discord server. Join first, then sync.'

	it('member proceeds with its roles', () => {
		expect(
			syncLookup(
				classifyMemberResponse({
					result: { user: { username: 'u' }, roles: ['r1'] },
				}),
			),
		).toEqual({ ok: true, roles: ['r1'] })
	})
	it('unknown member (10007) says join first', () => {
		const r = syncLookup(classifyMemberResponse({ result: { code: 10007 } }))
		expect(r).toMatchObject({ ok: false })
		expect((r as { error: string }).error).toContain('Not a member')
	})
	it('an error body says Discord could not be reached, not "Not a member"', () => {
		const body = { code: 50001, message: 'Missing Access' }
		expect(legacy(body)).toContain('Not a member')
		const r = syncLookup(classifyMemberResponse({ result: body }))
		expect(r).toEqual({ ok: false, error: FETCH_ERROR_COPY })
	})
	it('a thrown lookup (non-404) says Discord could not be reached', () => {
		const r = syncLookup(classifyMemberResponse({ thrown: { status: 500 } }))
		expect(r).toEqual({ ok: false, error: FETCH_ERROR_COPY })
	})
	it('a thrown 404 says join first', () => {
		const r = syncLookup(classifyMemberResponse({ thrown: { status: 404 } }))
		expect((r as { error: string }).error).toContain('Not a member')
	})
})

describe('isDiscordConnected', () => {
	const accounts: [string, Acct, boolean][] = [
		['none', null, false],
		['token', { provider: 'discord', access_token: 'tok' }, true],
		['tokenless', { provider: 'discord', access_token: null }, false],
		['empty token', { provider: 'discord', access_token: '' }, false],
		['other provider', { provider: 'github', access_token: 'tok' }, false],
		['no provider', { access_token: 'tok' }, false],
	]
	it.each(accounts)('%s -> %s', (_name, account, expected) => {
		expect(isDiscordConnected(account)).toBe(expected)
	})
	it('closes the old disagreement: /discord and welcome now agree on every account', () => {
		const tokenless = { provider: 'discord', access_token: null }
		// legacy: the two pages disagreed on exactly this account
		expect(legacyDiscordState(tokenless)).toBe('reconnect-required')
		expect(legacyWelcomeConnected(tokenless)).toBe(true)
		// shared predicate: not connected, so welcome keeps its CTA and /discord asks to reconnect
		expect(isDiscordConnected(tokenless)).toBe(false)
	})
	it('hasDiscordAccount only needs the row, which is what role sync uses', () => {
		expect(hasDiscordAccount({ provider: 'discord' })).toBe(true)
		expect(hasDiscordAccount({ provider: 'github' })).toBe(false)
		expect(hasDiscordAccount(null)).toBe(false)
	})
})

describe('/discord state vs legacy', () => {
	const accts: [string, Acct][] = [
		['none', null],
		['token', { provider: 'discord', access_token: 'tok' }],
		['tokenless', { provider: 'discord', access_token: null }],
	]
	const links = [undefined, 'expired', 'denied', 'account-conflict']
	const session = async () => ({ session: { user: { id: 'u' } } })
	for (const [name, account] of accts) {
		for (const link of links) {
			it(`${name} link=${link ?? 'none'} matches legacy`, async () => {
				const state = await getDiscordAccessState({
					getSession: session,
					findDiscordAccount: async () => account,
					linkResult: link,
				})
				expect(state).toBe(legacyDiscordState(account, link))
			})
		}
	}
	it.each(['expired', 'denied', 'account-conflict'])(
		'a tokenless account with link=%s keeps the link result',
		async (link) => {
			const state = await getDiscordAccessState({
				getSession: session,
				findDiscordAccount: async () => ({
					provider: 'discord',
					access_token: null,
				}),
				linkResult: link,
			})
			expect(state).toBe(link)
		},
	)
})

describe('real query row shape', () => {
	// getDiscordAccount and discordAccountsForCurrentUser select whole account rows
	// (no narrowed columns), so provider is always present.
	const row = {
		userId: 'u',
		type: 'oauth',
		provider: 'discord',
		providerAccountId: 'd1',
		access_token: 'tok',
		refresh_token: null,
		expires_at: null,
	}
	it('reads a full linked row as connected on /discord and welcome', async () => {
		const state = await getDiscordAccessState({
			getSession: async () => ({ session: { user: { id: 'u' } } }),
			findDiscordAccount: async () => row,
		})
		expect(state).toBe('linked')
		expect([row].some(isDiscordConnected)).toBe(true)
	})
})

describe('classifyMemberResponse', () => {
	it('classifies a member', () => {
		expect(
			classifyMemberResponse({
				result: { user: { username: 'u' }, roles: ['1', '2'] },
			}),
		).toEqual({ kind: 'member', roles: ['1', '2'], username: 'u' })
	})
	it('treats Unknown Member (10007) as not in the server, not an error', () => {
		expect(
			classifyMemberResponse({
				result: { code: 10007, message: 'Unknown Member' },
			}),
		).toEqual({ kind: 'not-member' })
	})
	it('treats a thrown 404 as not in the server', () => {
		expect(classifyMemberResponse({ thrown: { status: 404 } })).toEqual({
			kind: 'not-member',
		})
	})
	it.each([
		[
			'another error code',
			{ result: { code: 50001, message: 'Missing Access' } },
		],
		[
			'a 429 body',
			{ result: { message: 'rate limited', retry_after: 1, global: false } },
		],
		['a thrown 429', { thrown: { status: 429 } }],
		['a thrown network error', { thrown: new Error('boom') }],
		['null', { result: null }],
		['a parse error result', { result: new SyntaxError('bad json') }],
	])('classifies %s as an error', (_n, outcome) => {
		expect(classifyMemberResponse(outcome)).toEqual({ kind: 'error' })
	})
})

describe('sourceLabel', () => {
	it.each([
		['PURCHASE', 'Purchase'],
		['SUBSCRIPTION', 'Subscription'],
		['COUPON', 'Coupon or team seat'],
		['MANUAL', 'Added by support'],
		['purchase', 'Purchase'],
	])('%s -> %s', (source, label) => {
		expect(sourceLabel(source)).toBe(label)
	})
	it.each([
		'bulk_redeem',
		'mystery_source',
		'',
		null,
		undefined,
		'__proto__',
		'toString',
	])('unknown source %s gets the generic label, never raw text', (source) => {
		expect(sourceLabel(source)).toBe('Course access')
	})
})

describe('discordErrorMessage', () => {
	it.each(DISCORD_ERROR_CODES)('maps known code %s to fixed copy', (code) => {
		expect(discordErrorMessage(code)).toBe(DISCORD_ERROR_MESSAGES[code])
		expect(discordErrorMessage(code)).not.toBe(GENERIC_DISCORD_ERROR)
	})
	it.each([
		'something-new',
		'<script>alert(1)</script>',
		'%E0%A4%A',
		'100%',
		'%',
		'',
		undefined,
		'__proto__',
		'constructor',
		['a'] as unknown as string,
		42 as unknown as string,
	])('unknown code %s gives the generic fallback without throwing', (code) => {
		expect(() => discordErrorMessage(code)).not.toThrow()
		expect(discordErrorMessage(code)).toBe(GENERIC_DISCORD_ERROR)
	})
})
