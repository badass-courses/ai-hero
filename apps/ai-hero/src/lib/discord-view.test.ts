import { describe, expect, it } from 'vitest'

import {
	DISCORD_ERROR_CODES,
	DISCORD_ERROR_MESSAGES,
	discordErrorMessage,
	discordRolesView,
	GENERIC_DISCORD_ERROR,
	isDiscordConnected,
	sourceLabel,
	type DiscordRolesView,
	type MemberFetch,
} from './discord-view'

// The behavior before this change, copied verbatim in spirit.
const legacyRolesView = ({
	roles,
	connected,
}: {
	roles: { assigned: boolean }[]
	memberFetch: MemberFetch
	connected: boolean
}) => {
	if (!connected) return 'connect'
	if (roles.length === 0) return 'no-roles'
	return roles.every((r) => r.assigned) ? 'all-assigned' : 'needs-sync'
}
const legacyDiscordPageConnected = (
	a: { access_token?: string | null } | null,
) => Boolean(a?.access_token)
const legacyWelcomeConnected = (a: object | null) => a !== null

const roleSets = {
	none: [],
	allAssigned: [{ assigned: true }, { assigned: true }],
	someAssigned: [{ assigned: true }, { assigned: false }],
	noneAssigned: [{ assigned: false }],
}

describe('discordRolesView truth table', () => {
	const cases: [
		keyof typeof roleSets,
		MemberFetch,
		boolean,
		DiscordRolesView,
	][] = []
	for (const connected of [true, false]) {
		for (const fetch of ['ok', 'error'] as const) {
			for (const key of Object.keys(roleSets) as (keyof typeof roleSets)[]) {
				const expected: DiscordRolesView = !connected
					? 'connect'
					: fetch === 'error'
						? 'fetch-error'
						: key === 'none'
							? 'no-roles'
							: key === 'allAssigned'
								? 'all-assigned'
								: 'needs-sync'
				cases.push([key, fetch, connected, expected])
			}
		}
	}

	it.each(cases)(
		'roles=%s fetch=%s connected=%s -> %s',
		(key, fetch, connected, expected) => {
			expect(
				discordRolesView({
					roles: roleSets[key],
					memberFetch: fetch,
					connected,
				}),
			).toBe(expected)
		},
	)

	it('differs from the legacy view exactly where a failed fetch was shown as needs sync', () => {
		const diffs = cases.filter(
			([key, fetch, connected]) =>
				legacyRolesView({
					roles: roleSets[key],
					memberFetch: fetch,
					connected,
				}) !==
				discordRolesView({
					roles: roleSets[key],
					memberFetch: fetch,
					connected,
				}),
		)
		expect(diffs.length).toBeGreaterThan(0)
		for (const [, fetch, connected] of diffs) {
			expect(fetch).toBe('error')
			expect(connected).toBe(true)
		}
	})
})

describe('isDiscordConnected', () => {
	it('treats an account without an access token as connected, like sync does', () => {
		const account = { provider: 'discord', access_token: null }
		expect(isDiscordConnected(account)).toBe(true)
		expect(legacyDiscordPageConnected(account)).toBe(false)
		expect(legacyWelcomeConnected(account)).toBe(true)
	})
	it('is false without an account', () => {
		expect(isDiscordConnected(null)).toBe(false)
		expect(isDiscordConnected(undefined)).toBe(false)
	})
})

describe('sourceLabel', () => {
	it.each([
		['purchase', 'Purchase'],
		['PURCHASE', 'Purchase'],
		['coupon', 'Coupon'],
		['bulk_redeem', 'Team seat'],
		['comp', 'Complimentary access'],
		['manual', 'Added by support'],
	])('%s -> %s', (source, label) => {
		expect(sourceLabel(source)).toBe(label)
	})
	it.each(['mystery_source', '', null, undefined, '__proto__', 'toString'])(
		'unknown source %s gets the generic label, never raw text',
		(source) => {
			expect(sourceLabel(source)).toBe('Course access')
		},
	)
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
	])('unknown code %s gives the generic fallback without throwing', (code) => {
		expect(() => discordErrorMessage(code)).not.toThrow()
		expect(discordErrorMessage(code)).toBe(GENERIC_DISCORD_ERROR)
	})
})
