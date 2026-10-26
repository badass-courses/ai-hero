import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { MySqlDatabase } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

import * as schema from '@/db/schema'
import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import { guardLegendGiftCouponPaths } from '@/lib/legend-gift-coupon-guard'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'
import {
	FULL_PRICE_COUPON_REDEEMED_EVENT,
	TEAM_SEAT_REDEMPTION_CREATED_EVENT,
} from '@coursebuilder/core/events/commerce'

// Only the session, outbound events, the login email and logging are stubbed.
// The action, data source, guarded adapter and redemption run for real.
const state = vi.hoisted(() => ({
	database: undefined as unknown,
	adapter: undefined as unknown,
	session: { current: null as null | { user: { id: string } } },
	send: vi.fn(),
	sendServerEmail: vi.fn(),
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/db', () => ({
	get db() {
		return state.database
	},
	get courseBuilderAdapter() {
		return state.adapter
	},
}))
vi.mock('@/server/auth', () => ({
	authOptions: {},
	getServerAuthSession: async () => ({ session: state.session.current }),
}))
vi.mock('@/server/logger', () => ({ log: state.log }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/env.mjs', () => ({
	env: { COURSEBUILDER_URL: 'https://example.test' },
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: state.send } }))
vi.mock('@/coursebuilder/email-provider', () => ({ emailProvider: {} }))
vi.mock('@coursebuilder/email/send-server-email', () => ({
	sendServerEmail: state.sendServerEmail,
}))
vi.mock('@/lib/team-manager-invitations-drizzle', () => ({}))

import { addTeamSeatsByEmailAction } from '@/app/(user)/team/actions'

// A database prepared by `scripts/test-mysql.sh schema <db>`.
const uri = process.env.AIH_TEAM_SEATS_MYSQL_URL
const suite = uri ? describe : describe.skip

function assertLoopbackTestDatabase(raw: string): string {
	const url = new URL(raw)
	if (
		url.protocol !== 'mysql:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
		['', '/mysql', '/sys'].includes(url.pathname)
	) {
		throw new Error('unsafe-team-seats-mysql-test-url')
	}
	return raw
}

const run = randomUUID().slice(0, 8)
const id = (name: string) => `${name}-${run}`
const email = (name: string) => `${name}-${run}@example.test`
const ids = {
	organization: id('org'),
	owner: id('user-owner'),
	learner: id('user-learner'),
	alreadyOwns: id('user-already-owns'),
	existing: id('user-existing'),
	ownerMembership: id('membership-owner'),
	learnerMembership: id('membership-learner'),
	ownerRole: id('role-owner'),
	learnerRole: id('role-learner'),
	product: id('product'),
	coupon: id('coupon-bulk'),
	bulkPurchase: id('purchase-bulk'),
	ownedPurchase: id('purchase-owned'),
}
const SEATS = 3

function form(emails: string) {
	const formData = new FormData()
	formData.set('purchaseId', ids.bulkPurchase)
	formData.set('emails', emails)
	return formData
}
const idle = { status: 'idle' as const, message: '', results: [] }

suite('add team seats by email against real MySQL', () => {
	let pool: Pool
	let db: MySqlDatabase<any, any, typeof schema>

	const usedCount = async () =>
		(
			await db.query.coupon.findFirst({ where: eq(schema.coupon.id, ids.coupon) })
		)?.usedCount

	beforeAll(async () => {
		pool = preserveQueryResultShape(
			mysql.createPool({
				uri: assertLoopbackTestDatabase(uri!),
				connectionLimit: 2,
				timezone: 'Z',
			}),
		)
		db = drizzle(pool, { schema, mode: 'planetscale' }) as any
		state.database = db
		// The same construction as `src/db/index.ts`, minus the Stripe provider
		// and pricing hook, which redemption never calls.
		state.adapter = guardLegendGiftCouponPaths(
			DrizzleAdapter<MySqlDatabase<any, any, any>>(db, mysqlTable),
		)

		await db.insert(schema.users).values([
			{ id: ids.owner, email: email('owner') },
			{ id: ids.learner, email: email('learner') },
			{ id: ids.alreadyOwns, email: email('already-owns') },
			{ id: ids.existing, email: email('existing') },
		])
		await db
			.insert(schema.organization)
			.values({ id: ids.organization, name: 'Synthetic Team' })
		await db.insert(schema.organizationMemberships).values([
			{
				id: ids.ownerMembership,
				organizationId: ids.organization,
				userId: ids.owner,
				role: 'owner',
				invitedById: ids.owner,
			},
			{
				id: ids.learnerMembership,
				organizationId: ids.organization,
				userId: ids.learner,
				role: 'learner',
				invitedById: ids.owner,
			},
		])
		await db.insert(schema.roles).values([
			{ id: ids.ownerRole, name: 'owner', organizationId: ids.organization },
			{
				id: ids.learnerRole,
				name: 'learner',
				organizationId: ids.organization,
			},
		])
		await db.insert(schema.organizationMembershipRoles).values([
			{
				organizationMembershipId: ids.ownerMembership,
				roleId: ids.ownerRole,
				organizationId: ids.organization,
			},
			{
				organizationMembershipId: ids.learnerMembership,
				roleId: ids.learnerRole,
				organizationId: ids.organization,
			},
		])
		await db.insert(schema.products).values({
			id: ids.product,
			name: 'Synthetic Team Course',
			type: 'self-paced',
			quantityAvailable: -1,
			status: 1,
			fields: { slug: id('synthetic-team-course'), state: 'published' },
		})
		await db.insert(schema.coupon).values({
			id: ids.coupon,
			organizationId: ids.organization,
			maxUses: SEATS,
			usedCount: 0,
			status: 1,
			percentageDiscount: '1.00',
			restrictedToProductId: ids.product,
		})
		await db.insert(schema.purchases).values([
			{
				id: ids.bulkPurchase,
				userId: ids.owner,
				productId: ids.product,
				bulkCouponId: ids.coupon,
				organizationId: ids.organization,
				totalAmount: '1000',
				status: 'Valid',
			},
			{
				id: ids.ownedPurchase,
				userId: ids.alreadyOwns,
				productId: ids.product,
				totalAmount: '100',
				status: 'Valid',
			},
		])
	})

	afterAll(async () => {
		await pool?.end()
	})

	beforeEach(() => {
		state.send.mockClear()
		state.sendServerEmail.mockClear()
		state.session.current = { user: { id: ids.owner } }
	})

	it('refuses a learner in the organization and takes no seat', async () => {
		state.session.current = { user: { id: ids.learner } }
		const result = await addTeamSeatsByEmailAction(idle, form(email('new-a')))
		expect(result.status).toBe('error')
		expect(await usedCount()).toBe(0)
	})

	it('adds seats in order, skips owners and duplicates, and stops at the cap', async () => {
		const result = await addTeamSeatsByEmailAction(
			idle,
			form(
				[
					email('already-owns'),
					email('new-a'),
					email('existing'),
					email('NEW-A').toUpperCase(),
					email('new-b'),
					email('new-c'),
				].join('\n'),
			),
		)

		expect(result.status).toBe('success')
		expect(result.results).toEqual([
			{ email: email('already-owns'), status: 'already-had-access' },
			{ email: email('new-a'), status: 'added' },
			{ email: email('existing'), status: 'added' },
			{ email: email('new-b'), status: 'added' },
			{ email: email('new-c'), status: 'no-seats-left' },
		])
		expect(await usedCount()).toBe(SEATS)

		const seats = await db.query.purchases.findMany({
			where: and(
				eq(schema.purchases.redeemedBulkCouponId, ids.coupon),
				eq(schema.purchases.status, 'Valid'),
			),
			with: { user: true },
		})
		expect(seats.map(({ user }) => user?.email).sort()).toEqual(
			[email('existing'), email('new-a'), email('new-b')].sort(),
		)
		expect(seats.every(({ productId }) => productId === ids.product)).toBe(true)
		expect(
			seats.find(({ user }) => user?.email === email('existing'))?.userId,
		).toBe(ids.existing)

		// The owner who already had the product gained no seat.
		const ownerPurchases = await db.query.purchases.findMany({
			where: eq(schema.purchases.userId, ids.alreadyOwns),
		})
		expect(ownerPurchases.map(({ id }) => id)).toEqual([ids.ownedPurchase])

		// Course Builder's redeem follow-up: a team-seat event per seat, and a
		// login email only for the accounts the redemption created.
		const seatEvents = state.send.mock.calls.filter(
			([event]) => event.name === TEAM_SEAT_REDEMPTION_CREATED_EVENT,
		)
		expect(seatEvents).toHaveLength(3)
		const redeemedEvents = state.send.mock.calls.filter(
			([event]) => event.name === FULL_PRICE_COUPON_REDEEMED_EVENT,
		)
		expect(
			redeemedEvents.map(([event]) => event.data.purchaseId).sort(),
		).toEqual(seats.map(({ id }) => id).sort())
		expect(
			state.sendServerEmail.mock.calls.map(([options]) => options.email).sort(),
		).toEqual([email('new-a'), email('new-b')].sort())
	})

	it('reports a second submission as already had access without a second seat', async () => {
		await db
			.update(schema.coupon)
			.set({ maxUses: SEATS + 1 })
			.where(eq(schema.coupon.id, ids.coupon))

		const result = await addTeamSeatsByEmailAction(idle, form(email('new-a')))

		expect(result.results).toEqual([
			{ email: email('new-a'), status: 'already-had-access' },
		])
		expect(await usedCount()).toBe(SEATS)
		const newA = await db.query.users.findFirst({
			where: eq(schema.users.email, email('new-a')),
		})
		const seats = await db.query.purchases.findMany({
			where: inArray(schema.purchases.userId, [newA!.id]),
		})
		expect(seats).toHaveLength(1)
	})
})
