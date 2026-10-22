import { UserSchema } from '@/ability'
import * as schema from '@/db/schema'
import { determineOrgAccess } from '@/utils/determine-org-access'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { describe, expect, it, vi } from 'vitest'

import { userSchema } from '@coursebuilder/core/schemas'

import { createFakeStore } from './__fixtures__/session-access'
import {
	createSessionAccessLoader,
	createSessionCallback,
	createSessionEntitlementsLoader,
	selectCurrentMembership,
	type SessionEntitlementRow,
} from './session-access'
import {
	createSessionAccessCache,
	type SessionAccessCache,
} from './session-access-cache'

const TOKEN = '6d1f0c4e-2b8a-4c3d-9e7f-1a2b3c4d5e6f'

const at = (iso: string) => new Date(iso)

function role(
	id: string,
	name: string,
	organizationId: string | null,
	overrides: Partial<{ active: boolean; deletedAt: Date | null }> = {},
) {
	return {
		id,
		organizationId,
		name,
		description: null,
		active: overrides.active ?? true,
		createdAt: at('2025-01-01T00:00:00.000Z'),
		updatedAt: at('2025-01-01T00:00:00.000Z'),
		deletedAt: overrides.deletedAt ?? null,
	}
}

/** The database as both the old and new session callback see it. */
function fixtureDatabase() {
	const userRoles = [
		{ userId: 'user-1', roleId: 'role-admin', role: role('role-admin', 'admin', null) },
		{ userId: 'user-1', roleId: 'role-user', role: role('role-user', 'user', null) },
	]
	const memberships = [
		{
			id: 'membership-team-late',
			organizationId: 'org-team',
			userId: 'user-1',
			createdAt: at('2025-03-01T00:00:00.000Z'),
			organization: { id: 'org-team', name: 'Team' },
			organizationMembershipRoles: [
				{
					active: true,
					deletedAt: null,
					role: role('role-team-learner', 'learner', 'org-team'),
				},
			],
		},
		{
			id: 'membership-personal',
			organizationId: 'org-personal',
			userId: 'user-1',
			createdAt: at('2025-01-01T00:00:00.000Z'),
			organization: { id: 'org-personal', name: 'Personal' },
			organizationMembershipRoles: [
				{
					active: true,
					deletedAt: null,
					role: role('role-personal-owner', 'owner', 'org-personal'),
				},
				{
					active: false,
					deletedAt: null,
					role: role('role-personal-old', 'billing_admin', 'org-personal'),
				},
				{
					active: true,
					deletedAt: at('2025-02-01T00:00:00.000Z'),
					role: role('role-personal-gone', 'member', 'org-personal'),
				},
				{
					active: true,
					deletedAt: null,
					role: role('role-personal-off', 'viewer', 'org-personal', {
						active: false,
					}),
				},
			],
		},
		{
			id: 'membership-team-early',
			organizationId: 'org-team',
			userId: 'user-1',
			createdAt: at('2025-02-01T00:00:00.000Z'),
			organization: { id: 'org-team', name: 'Team' },
			organizationMembershipRoles: [],
		},
	]
	const accounts = [
		{
			provider: 'discord',
			providerAccountId: 'discord-1',
			access_token: 'discord-access-secret',
			refresh_token: 'discord-refresh-secret',
			expires_at: 1_900_000_000,
		},
		{
			provider: 'github',
			providerAccountId: 'github-1',
			access_token: 'github-access-secret',
			refresh_token: null,
			expires_at: null,
		},
	]
	const entitlementsByMembership: Record<string, SessionEntitlementRow[]> = {
		'membership-personal': [
			{
				entitlementType: 'cohort_content_access',
				expiresAt: at('2026-12-01T00:00:00.000Z'),
				metadata: { contentIds: ['cohort-1'] },
			},
		],
		'membership-team-early': [
			{ entitlementType: 'cohort_discord_role', expiresAt: null, metadata: {} },
		],
		'membership-team-late': [
			{ entitlementType: 'must-not-appear', expiresAt: null, metadata: null },
		],
	}
	return { userRoles, memberships, accounts, entitlementsByMembership }
}

type Fixture = ReturnType<typeof fixtureDatabase>

const adapterUser = {
	id: 'user-1',
	name: 'Learner',
	email: 'learner@example.com',
	emailVerified: null,
	image: null,
	role: 'admin',
	fields: {},
	createdAt: at('2024-01-01T00:00:00.000Z'),
}

const adapterSession = () => ({
	sessionToken: TOKEN,
	userId: 'user-1',
	expires: at('2030-01-01T00:00:00.000Z'),
	user: adapterUser,
})

/**
 * The former session callback, kept verbatim in shape for parity: the heavy
 * user read, the separate userRoles read, and the ordered membership read.
 */
async function legacySession(fixture: Fixture, requestedOrganizationId: string | null) {
	const { resolveSessionOrganizationId } = await import('./organization-context')
	const dbUser = {
		...adapterUser,
		accounts: fixture.accounts,
		organizationMemberships: fixture.memberships,
	}
	const role = dbUser.role || 'user'
	const organizationRoles =
		dbUser.organizationMemberships.flatMap((membership) =>
			membership.organizationMembershipRoles.flatMap((membershipRole) =>
				membershipRole.active &&
				!membershipRole.deletedAt &&
				membershipRole.role.active &&
				!membershipRole.role.deletedAt
					? [membershipRole.role]
					: [],
			),
		) || []
	const organizationId = resolveSessionOrganizationId(
		requestedOrganizationId,
		organizationRoles,
	)
	const currentMembership = organizationId
		? ([...fixture.memberships]
				.filter((membership) => membership.organizationId === organizationId)
				.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null)
		: null
	const activeEntitlements = currentMembership
		? (fixture.entitlementsByMembership[currentMembership.id] ?? [])
		: []
	const session = adapterSession()
	return {
		...session,
		user: {
			...session.user,
			id: 'user-1',
			role,
			roles: fixture.userRoles.map((userRole) => userRole.role),
			organizationRoles,
			entitlements: activeEntitlements.map((e) => ({
				type: e.entitlementType,
				expires: e.expiresAt,
				metadata: e.metadata || null,
			})),
		},
	}
}

/** What the slim relational query returns for the fixture. */
function slimRow(fixture: Fixture) {
	return {
		id: 'user-1',
		roles: fixture.userRoles.map(({ roleId, role }) => ({ roleId, role })),
		accounts: fixture.accounts
			.filter((account) => account.provider === 'discord')
			.map(({ expires_at }) => ({ expires_at })),
		organizationMemberships: fixture.memberships.map(
			({ id, organizationId, createdAt, organizationMembershipRoles }) => ({
				id,
				organizationId,
				createdAt,
				organizationMembershipRoles,
			}),
		),
	}
}

function harness({
	fixture = fixtureDatabase(),
	requestedOrganizationId = null as string | null,
	cache,
	now = () => 1_800_000_000_000,
}: {
	fixture?: Fixture
	requestedOrganizationId?: string | null
	cache?: SessionAccessCache
	now?: () => number
} = {}) {
	const findFirst = vi.fn(async () => slimRow(fixture))
	const loadAccess = vi.fn(
		createSessionAccessLoader({ query: { users: { findFirst } } } as never),
	)
	const loadEntitlements = vi.fn(
		async (membershipId: string) =>
			fixture.entitlementsByMembership[membershipId] ?? [],
	)
	const onExpiredDiscordToken = vi.fn(async () => {})
	const store = createFakeStore()
	const resolvedCache =
		cache ??
		createSessionAccessCache({ getStore: async () => store, ttlSeconds: 60 })
	const callback = createSessionCallback({
		loadAccess,
		loadEntitlements,
		getRequestedOrganizationId: async () => requestedOrganizationId,
		cache: resolvedCache,
		onExpiredDiscordToken,
		now,
	})
	const run = () => callback({ session: adapterSession(), user: adapterUser })
	return { fixture, run, loadAccess, loadEntitlements, onExpiredDiscordToken, store }
}

const consumers = (session: Awaited<ReturnType<typeof legacySession>>) => ({
	proxyAdmin: session.user.roles.some((r) => r.name === 'admin'),
	proxyOrgAccess: determineOrgAccess(
		session.user.organizationRoles as never,
		undefined,
	),
	proxyOrgAccessWithCookie: determineOrgAccess(
		session.user.organizationRoles as never,
		'org-team',
	),
	coreUser: userSchema.optional().nullable().parse(session.user),
	abilityUser: UserSchema.nullish().parse(session.user),
	clientJson: JSON.parse(JSON.stringify(session)),
})

describe('session callback parity', () => {
	for (const requestedOrganizationId of [null, 'org-team', 'org-personal', 'org-stranger']) {
		it(`matches the former session for requested org ${requestedOrganizationId}`, async () => {
			const { fixture, run } = harness({ requestedOrganizationId })
			const expected = await legacySession(fixture, requestedOrganizationId)

			const miss = await run()
			const hit = await run()

			expect(miss).toEqual(expected)
			expect(hit).toEqual(expected)
			expect(consumers(miss as never)).toEqual(consumers(expected))
			expect(consumers(hit as never)).toEqual(consumers(expected))
		})
	}

	it('selects the earliest membership for the organization', () => {
		const { memberships } = fixtureDatabase()
		expect(selectCurrentMembership(memberships, 'org-team')?.id).toBe(
			'membership-team-early',
		)
		expect(selectCurrentMembership(memberships, null)).toBeNull()
		expect(selectCurrentMembership(memberships, 'org-stranger')).toBeNull()
		expect(
			selectCurrentMembership(
				[
					{ id: 'dated', organizationId: 'o', createdAt: at('2025-01-01T00:00:00Z') },
					{ id: 'undated', organizationId: 'o', createdAt: null },
				],
				'o',
			)?.id,
		).toBe('undated')
	})

	it('defaults the role to user like the former callback', async () => {
		const { run } = harness()
		const callback = await run()
		expect(callback.user.role).toBe('admin')

		const anonymousRole = createSessionCallback({
			loadAccess: async () => ({
				roles: [],
				organizationRoles: [],
				memberships: [],
				discord: null,
			}),
			loadEntitlements: async () => [],
			getRequestedOrganizationId: async () => null,
			cache: createSessionAccessCache({ getStore: async () => null, ttlSeconds: 60 }),
			onExpiredDiscordToken: async () => {},
		})
		const session = await anonymousRole({
			session: adapterSession(),
			user: { ...adapterUser, role: null as never },
		})
		expect(session.user.role).toBe('user')
	})
})

describe('session callback cache', () => {
	it('loads roles and memberships once per TTL and entitlements every time', async () => {
		const { run, loadAccess, loadEntitlements } = harness({
			requestedOrganizationId: 'org-personal',
		})
		await run()
		await run()
		await run()
		expect(loadAccess).toHaveBeenCalledTimes(1)
		expect(loadEntitlements).toHaveBeenCalledTimes(3)
	})

	it('reloads after a membership change busts the user', async () => {
		const fixture = fixtureDatabase()
		const store = createFakeStore()
		const cache = createSessionAccessCache({
			getStore: async () => store,
			ttlSeconds: 60,
		})
		const { run, loadAccess } = harness({ fixture, cache })
		const before = await run()
		expect(before.user.organizationRoles.map((r) => r.id)).toContain(
			'role-team-learner',
		)

		fixture.memberships.splice(0, 1)
		await cache.bustUser('user-1')
		const after = await run()

		expect(loadAccess).toHaveBeenCalledTimes(2)
		expect(after.user.organizationRoles.map((r) => r.id)).not.toContain(
			'role-team-learner',
		)
		expect(after).toEqual(await legacySession(fixture, null))
	})

	it('does not cache users still being provisioned', async () => {
		const fixture = fixtureDatabase()
		fixture.userRoles.length = 0
		const { run, loadAccess, store } = harness({ fixture })
		await run()
		await run()
		expect(loadAccess).toHaveBeenCalledTimes(2)
		expect(store.set).not.toHaveBeenCalled()
	})

	it('falls through to the database when Redis is down', async () => {
		const down = new Error('ECONNREFUSED')
		const cache = createSessionAccessCache({
			getStore: async () => ({
				mget: vi.fn().mockRejectedValue(down),
				set: vi.fn().mockRejectedValue(down),
				del: vi.fn().mockRejectedValue(down),
				incr: vi.fn().mockRejectedValue(down),
				expire: vi.fn().mockRejectedValue(down),
			}),
			ttlSeconds: 60,
		})
		const { fixture, run, loadAccess } = harness({
			cache,
			requestedOrganizationId: 'org-team',
		})
		expect(await run()).toEqual(await legacySession(fixture, 'org-team'))
		expect(await run()).toEqual(await legacySession(fixture, 'org-team'))
		expect(loadAccess).toHaveBeenCalledTimes(2)
	})

	it('reads live without a session token', async () => {
		const { fixture, loadAccess } = harness()
		const store = createFakeStore()
		const callback = createSessionCallback({
			loadAccess,
			loadEntitlements: async () => [],
			getRequestedOrganizationId: async () => null,
			cache: createSessionAccessCache({ getStore: async () => store, ttlSeconds: 60 }),
			onExpiredDiscordToken: async () => {},
		})
		const { sessionToken: _omit, ...session } = adapterSession()
		await callback({ session, user: adapterUser })
		await callback({ session, user: adapterUser })
		expect(loadAccess).toHaveBeenCalledTimes(2)
		expect(store.mget).not.toHaveBeenCalled()
		expect(fixture).toBeTruthy()
	})
})

describe('session callback Discord expiry', () => {
	it('hands an expired Discord token to the refresh hook only', async () => {
		const expired = harness({ now: () => 1_900_000_000_000 })
		await expired.run()
		expect(expired.onExpiredDiscordToken).toHaveBeenCalledWith('user-1')

		const fresh = harness({ now: () => 1_800_000_000_000 })
		await fresh.run()
		expect(fresh.onExpiredDiscordToken).not.toHaveBeenCalled()

		const fixture = fixtureDatabase()
		fixture.accounts.length = 0
		const none = harness({ fixture, now: () => 1_900_000_000_000 })
		await none.run()
		expect(none.onExpiredDiscordToken).not.toHaveBeenCalled()
	})

	it('caches only the Discord expiry, never a token', async () => {
		const { run, store } = harness()
		await run()
		const written = JSON.stringify(vi.mocked(store.set).mock.calls)
		expect(written).toContain('1900000000')
		expect(written).not.toContain('secret')
		expect(written).not.toContain(TOKEN)
	})
})

function countingDatabase() {
	const statements: string[] = []
	const client = {
		query: vi.fn(async (query: { sql: string }) => {
			statements.push(query.sql)
			return [[], []]
		}),
	}
	const database = drizzle(client as never, { schema, mode: 'planetscale' })
	return { database, statements }
}

describe('queries per cookie-carrying auth()', () => {
	// The adapter's session+user join runs before the callback in both versions.
	const ADAPTER_STATEMENTS = 1

	it('counts the former callback', async () => {
		const { database, statements } = countingDatabase()
		await database.query.users.findFirst({
			where: (users, { eq }) => eq(users.id, 'user-1'),
			with: {
				accounts: true,
				organizationMemberships: {
					with: {
						organization: true,
						organizationMembershipRoles: { with: { role: true } },
					},
				},
			},
		})
		await database.query.userRoles.findMany({
			where: (ur, { eq }) => eq(ur.userId, 'user-1'),
			with: { role: true },
		})
		await database.query.organizationMemberships.findFirst({
			where: and(
				eq(schema.organizationMemberships.organizationId, 'org-1'),
				eq(schema.organizationMemberships.userId, 'user-1'),
			),
			orderBy: (om, { asc }) => [asc(om.createdAt)],
		})
		await database.query.entitlements.findMany({
			where: and(
				eq(schema.entitlements.organizationMembershipId, 'membership-1'),
				or(
					isNull(schema.entitlements.expiresAt),
					gt(schema.entitlements.expiresAt, sql`CURRENT_TIMESTAMP`),
				),
				isNull(schema.entitlements.deletedAt),
			),
		})
		expect(ADAPTER_STATEMENTS + statements.length).toBe(5)
		// The slim test below asserts these are gone.
		expect(statements[0]).toContain('access_token')
		expect(statements[0]).toMatch(/_organization["`]/)
	})

	it('counts the slim callback on a cache miss and a hit', async () => {
		const { database, statements } = countingDatabase()
		const loadAccess = createSessionAccessLoader(database)
		const loadEntitlements = createSessionEntitlementsLoader(database)

		await loadAccess('user-1')
		const accessStatements = statements.length
		await loadEntitlements('membership-1')
		const entitlementStatements = statements.length - accessStatements

		expect(accessStatements).toBe(1)
		expect(entitlementStatements).toBe(1)
		const miss = ADAPTER_STATEMENTS + accessStatements + entitlementStatements
		const hit = ADAPTER_STATEMENTS + entitlementStatements
		expect(miss).toBe(3)
		expect(hit).toBe(2)

		const accessSql = statements[0] ?? ''
		for (const column of ['access_token', 'refresh_token', 'id_token'])
			expect(accessSql).not.toContain(column)
		expect(accessSql).not.toMatch(/_organization["`]/)
	})
})
