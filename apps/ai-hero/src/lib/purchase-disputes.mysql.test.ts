import { preserveQueryResultShape } from '@/db/mysql-query-client'
import * as schema from '@/db/schema'
import { eq, is, SQL } from 'drizzle-orm'
import { getTableConfig, MySqlDialect } from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
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

const state = vi.hoisted(() => ({ database: undefined as unknown }))
vi.mock('@/db', () => ({
	get db() {
		return state.database
	},
}))

import type { DiscordRoleClient } from './discord-utils'
import {
	applyDisputeEvent,
	isUserBlockedFromPurchasing,
	lostDisputeConfirmed,
	markPurchaseDisputeRefunded,
	previewDisputeEvent,
	readDisputeRecord,
	readDisputeState,
	syncDisputeDiscordRole,
} from './purchase-disputes'

const uri = process.env.AIH_PURCHASE_DISPUTES_MYSQL_URL
const suite = uri ? describe : describe.skip
const dialect = new MySqlDialect()
const tables = [
	schema.users,
	schema.purchases,
	schema.entitlements,
	schema.entitlementTypes,
	schema.purchaseUserTransfer,
]

// Disposable DDL from the installed schema, never a production clone.
async function createFixtureSchema(pool: Pool) {
	for (const table of tables) {
		const config = getTableConfig(table)
		const columns = config.columns.map((column) => {
			const fallback =
				column.default === undefined
					? ''
					: column.default === null
						? ' DEFAULT NULL'
						: is(column.default, SQL)
							? ` DEFAULT ${dialect.sqlToQuery(column.default).sql}`
							: column.getSQLType() === 'json'
								? ` DEFAULT ('${JSON.stringify(column.default)}')`
								: ` DEFAULT '${String(column.default)}'`
			return `\`${column.name}\` ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${fallback}${column.primary ? ' PRIMARY KEY' : ''}`
		})
		if (!config.columns.some((column) => column.primary))
			for (const key of config.primaryKeys)
				columns.push(
					`PRIMARY KEY (${key.columns.map((column) => `\`${column.name}\``).join(',')})`,
				)
		await pool.query(`DROP TABLE IF EXISTS \`${config.name}\``)
		await pool.query(
			`CREATE TABLE \`${config.name}\` (${columns.join(',')}) ENGINE=InnoDB`,
		)
	}
}

const NOW = new Date('2026-10-09T12:00:00.000Z')
const LATER = new Date('2026-10-20T12:00:00.000Z')

suite('purchase disputes: real MySQL 8', () => {
	let pool: Pool
	let database: MySql2Database<typeof schema>

	beforeAll(async () => {
		const parsed = new URL(uri!)
		if (
			!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
			parsed.pathname !== '/purchase_disputes_test'
		)
			throw new Error(
				'Only the loopback purchase_disputes_test fixture is allowed',
			)
		const server = new URL(uri!)
		server.pathname = '/'
		const bootstrap = await mysql.createConnection({ uri: server.toString() })
		await bootstrap.query(
			'CREATE DATABASE IF NOT EXISTS purchase_disputes_test',
		)
		await bootstrap.end()
		pool = preserveQueryResultShape(
			mysql.createPool({ uri: uri!, connectionLimit: 4, timezone: 'Z' }),
		)
		const getConnection = pool.getConnection.bind(pool)
		pool.getConnection = (async () =>
			preserveQueryResultShape(
				await getConnection(),
			)) as typeof pool.getConnection
		await createFixtureSchema(pool)
		database = drizzle(pool, { schema, mode: 'planetscale' })
		state.database = database
	}, 30000)

	afterAll(async () => {
		await pool?.end()
	})

	beforeEach(async () => {
		for (const table of tables)
			await pool.query(`DELETE FROM \`${getTableConfig(table).name}\``)
		await database.insert(schema.users).values([
			{
				id: 'buyer',
				email: 'buyer@example.test',
				fields: { timezone: 'UTC' },
			},
			{ id: 'bystander', email: 'bystander@example.test' },
		])
		await database.insert(schema.entitlementTypes).values([
			{ id: 'workshop-type', name: 'workshop_content_access' },
			{ id: 'discord-type', name: 'workshop_discord_role' },
			{ id: 'credit-type', name: 'apply_special_credit' },
		])
		await database.insert(schema.purchases).values([
			{
				id: 'disputed',
				userId: 'buyer',
				productId: 'product-a',
				status: 'Restricted',
				totalAmount: '100',
				fields: { attribution: { source: 'fixture' } },
			},
			{
				id: 'other-product',
				userId: 'buyer',
				productId: 'product-b',
				status: 'Valid',
				totalAmount: '50',
			},
			{
				id: 'bystander-purchase',
				userId: 'bystander',
				productId: 'product-a',
				status: 'Valid',
				totalAmount: '100',
			},
		])
		const entitlement = (
			id: string,
			sourceId: string,
			overrides: Partial<typeof schema.entitlements.$inferInsert> = {},
		) => ({
			id,
			entitlementType: 'workshop-type',
			userId: 'buyer',
			sourceType: 'PURCHASE',
			sourceId,
			metadata: { contentIds: ['workshop-1'] },
			...overrides,
		})
		await database.insert(schema.entitlements).values([
			entitlement('content', 'disputed'),
			entitlement('discord', 'disputed', {
				entitlementType: 'discord-type',
				metadata: { discordRoleId: 'role-1' },
			}),
			// Removed earlier for an unrelated reason; a win must not revive it.
			entitlement('stale', 'disputed', {
				deletedAt: new Date('2026-01-01T00:00:00Z'),
			}),
			entitlement('credit', 'coupon-1', {
				entitlementType: 'credit-type',
				sourceType: 'COUPON',
				metadata: { eligibilityProductId: 'product-a' },
			}),
			entitlement('other-product-content', 'other-product'),
			entitlement('bystander-content', 'bystander-purchase', {
				userId: 'bystander',
			}),
		])
	})

	async function purchase(id: string) {
		return database.query.purchases.findFirst({
			where: eq(schema.purchases.id, id),
		})
	}
	async function active() {
		return (await database.query.entitlements.findMany())
			.filter((row) => !row.deletedAt)
			.map((row) => row.id)
			.sort()
	}

	const apply = (
		event: Parameters<typeof applyDisputeEvent>[0]['event'],
		extra: Partial<Parameters<typeof applyDisputeEvent>[0]> = {},
	) =>
		applyDisputeEvent({
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			event,
			now: NOW,
			...extra,
		})
	const setStatus = (status: string) =>
		database
			.update(schema.purchases)
			.set({ status })
			.where(eq(schema.purchases.id, 'disputed'))
	const record = async () =>
		readDisputeRecord((await purchase('disputed'))!.fields)

	function fakeDiscord(held: string[] = ['role-1']) {
		const roles = new Set(held)
		const calls: string[] = []
		const client: DiscordRoleClient = {
			lookupMember: async () => ({
				kind: 'member',
				discordAccountId: 'discord-buyer',
				roles: [...roles],
			}),
			addRole: async (_account, roleId) => {
				calls.push(`add ${roleId}`)
				roles.add(roleId)
			},
			removeRole: async (_account, roleId) => {
				calls.push(`remove ${roleId}`)
				roles.delete(roleId)
			},
		}
		return { client, roles, calls }
	}
	const syncRole = (discord: DiscordRoleClient) =>
		syncDisputeDiscordRole({
			purchaseId: 'disputed',
			stripeDisputeId: 'du_1',
			discordRoleId: 'role-1',
			now: NOW,
			discord,
		})

	describe('opened', () => {
		it('cuts exactly the purchase rows and unused credits, records them, and is idempotent', async () => {
			await expect(apply('opened')).resolves.toMatchObject({
				kind: 'applied',
				from: null,
				to: 'open',
				plannedStatus: 'Disputed',
				cutEntitlementIds: ['content', 'discord'],
				cutCreditEntitlementIds: ['credit'],
			})
			const row = await purchase('disputed')
			expect(row!.status).toBe('Disputed')
			expect(row!.fields).toMatchObject({ attribution: { source: 'fixture' } })
			expect(readDisputeRecord(row!.fields)).toEqual({
				stripeDisputeId: 'du_1',
				state: 'open',
				originalStatus: 'Restricted',
				openedAt: NOW.toISOString(),
				revokedEntitlementIds: ['content', 'discord', 'credit'],
				discordRoleIds: ['role-1'],
				discordSync: {},
			})
			expect(await active()).toEqual([
				'bystander-content',
				'other-product-content',
			])

			await expect(apply('opened', { now: LATER })).resolves.toMatchObject({
				kind: 'unchanged',
			})
			expect((await record())!.openedAt).toBe(NOW.toISOString())
		})

		it('trusts the status commerce read when it already wrote Disputed', async () => {
			await setStatus('Disputed')
			await apply('opened', { previousStatus: 'Restricted' })
			expect((await record())!.originalStatus).toBe('Restricted')
		})

		it('keeps unused credits while another paid purchase of the product survives', async () => {
			await database.insert(schema.purchases).values({
				id: 'second-copy',
				userId: 'buyer',
				productId: 'product-a',
				status: 'Valid',
				totalAmount: '100',
			})
			await apply('opened')
			expect(await active()).toContain('credit')
		})

		it('ignores a Banned seat redemption', async () => {
			await setStatus('Banned')
			await expect(apply('opened')).resolves.toMatchObject({
				kind: 'ignored',
				reason: 'status-Banned',
			})
			expect(await active()).toContain('content')
		})
	})

	describe('won', () => {
		it('restores the recorded status and rows, not unrelated deletions, once', async () => {
			await apply('opened')
			await expect(
				apply('won', { stripeDisputeId: 'du_other' }),
			).resolves.toMatchObject({ kind: 'ignored', reason: 'different-dispute' })

			await expect(apply('won', { now: LATER })).resolves.toMatchObject({
				kind: 'applied',
				to: 'won',
				plannedStatus: 'Restricted',
				restoreEntitlementIds: ['content', 'credit', 'discord'],
			})
			expect((await purchase('disputed'))!.status).toBe('Restricted')
			expect(await record()).toMatchObject({
				state: 'won',
				closedAt: LATER.toISOString(),
			})
			expect(await active()).toEqual([
				'bystander-content',
				'content',
				'credit',
				'discord',
				'other-product-content',
			])
			await expect(apply('won')).resolves.toMatchObject({ kind: 'unchanged' })
			expect(await isUserBlockedFromPurchasing('buyer')).toBe(false)
		})

		it('regression: won before opened stays closed when the late opened runs', async () => {
			await expect(apply('won')).resolves.toMatchObject({
				kind: 'applied',
				to: 'won',
				cutEntitlementIds: [],
			})
			await expect(
				apply('opened', { previousStatus: 'Restricted' }),
			).resolves.toMatchObject({ kind: 'unchanged', to: 'won' })
			expect((await purchase('disputed'))!.status).toBe('Restricted')
			expect(await active()).toContain('content')
		})

		it('regression: a late commerce Disputed write after a win is repaired', async () => {
			await apply('opened')
			await apply('won')
			await setStatus('Disputed')
			await expect(apply('reconcile')).resolves.toMatchObject({
				kind: 'repaired',
				plannedStatus: 'Restricted',
			})
			expect((await purchase('disputed'))!.status).toBe('Restricted')
			expect(await active()).toContain('content')
		})

		it('regression: an unknown original status restores access but holds the status', async () => {
			// Commerce wrote Disputed and the retry reported Disputed back.
			await setStatus('Disputed')
			await apply('opened', { previousStatus: 'Disputed' })
			expect((await record())!.originalStatus).toBeNull()
			await expect(apply('won')).resolves.toMatchObject({
				to: 'won',
				statusHeld: 'original-status-unknown',
				plannedStatus: 'Disputed',
			})
			expect((await purchase('disputed'))!.status).toBe('Disputed')
			expect(await active()).toContain('content')
		})
	})

	describe('refund overrides the dispute', () => {
		it('regression: a replayed Disputed write after a refund cannot regrant on a win', async () => {
			await apply('opened')
			await setStatus('Refunded')
			await expect(
				markPurchaseDisputeRefunded('disputed', LATER),
			).resolves.toEqual({ marked: true })
			// The pre-fix webhook overwrote Refunded unconditionally.
			await setStatus('Disputed')
			await apply('opened', { previousStatus: 'Refunded' })
			await apply('won')
			expect((await purchase('disputed'))!.status).toBe('Refunded')
			expect(await active()).not.toContain('content')
			expect(await record()).toMatchObject({
				state: 'won',
				refundedAt: LATER.toISOString(),
			})
		})

		it('a refund seen only as status is recorded and blocks restoration', async () => {
			await apply('opened')
			await setStatus('Refunded')
			await expect(apply('won')).resolves.toMatchObject({
				to: 'won',
				restoreEntitlementIds: [],
				plannedStatus: 'Refunded',
			})
			expect((await record())!.refundedAt).toBe(NOW.toISOString())
			expect(await active()).not.toContain('content')
		})

		it('lost on a refunded purchase blocks the buyer without touching it', async () => {
			await setStatus('Refunded')
			await expect(apply('lost')).resolves.toMatchObject({
				kind: 'applied',
				cutEntitlementIds: [],
				buyerOutcome: { status: 'blocked', userId: 'buyer' },
			})
			expect((await purchase('disputed'))!.status).toBe('Refunded')
			expect(await isUserBlockedFromPurchasing('buyer')).toBe(true)
		})
	})

	describe('lost', () => {
		it('cuts a never-marked purchase, blocks only the buyer, and keeps user fields', async () => {
			await expect(
				apply('lost', { previousStatus: 'Restricted' }),
			).resolves.toMatchObject({
				kind: 'applied',
				from: null,
				to: 'lost',
				buyerOutcome: {
					status: 'blocked',
					userId: 'buyer',
					alreadyBlocked: false,
				},
			})
			expect((await purchase('disputed'))!.status).toBe('Disputed')
			expect(await record()).toMatchObject({
				state: 'lost',
				originalStatus: 'Restricted',
				buyer: { status: 'blocked', userId: 'buyer' },
			})
			expect(await active()).toEqual([
				'bystander-content',
				'other-product-content',
			])
			const buyer = await database.query.users.findFirst({
				where: eq(schema.users.id, 'buyer'),
			})
			expect(buyer!.fields).toMatchObject({
				timezone: 'UTC',
				purchaseBlock: {
					reason: 'chargeback_lost',
					purchaseId: 'disputed',
					stripeDisputeId: 'du_1',
					blockedAt: NOW.toISOString(),
				},
			})
			expect(await isUserBlockedFromPurchasing('bystander')).toBe(false)
			expect(await isUserBlockedFromPurchasing(undefined)).toBe(false)

			await expect(apply('lost', { now: LATER })).resolves.toMatchObject({
				kind: 'unchanged',
			})
			// A loss is final: a stray won event cannot restore it.
			await expect(apply('won')).resolves.toMatchObject({
				kind: 'unchanged',
				reason: 'closed-lost',
			})
			expect(await active()).not.toContain('content')
		})

		it('regression: after a transfer it blocks the paying buyer, not the recipient', async () => {
			await database
				.update(schema.purchases)
				.set({ userId: 'bystander' })
				.where(eq(schema.purchases.id, 'disputed'))
			await database.insert(schema.purchaseUserTransfer).values({
				id: 'put_1',
				purchaseId: 'disputed',
				sourceUserId: 'buyer',
				targetUserId: 'bystander',
				transferState: 'COMPLETED',
				completedAt: NOW,
			})
			await expect(apply('lost')).resolves.toMatchObject({
				buyerOutcome: { status: 'blocked', userId: 'buyer' },
			})
			expect(await isUserBlockedFromPurchasing('bystander')).toBe(false)
			expect(await isUserBlockedFromPurchasing('buyer')).toBe(true)
		})

		it('holds the block when the transfer chain does not reach the owner', async () => {
			await database
				.update(schema.purchases)
				.set({ userId: 'bystander' })
				.where(eq(schema.purchases.id, 'disputed'))
			await database.insert(schema.purchaseUserTransfer).values({
				id: 'put_1',
				purchaseId: 'disputed',
				sourceUserId: 'buyer',
				targetUserId: 'someone-else',
				transferState: 'COMPLETED',
				completedAt: NOW,
			})
			await expect(apply('lost')).resolves.toMatchObject({
				buyerOutcome: { status: 'held', reason: 'transfer-chain-ambiguous' },
			})
			expect(await isUserBlockedFromPurchasing('bystander')).toBe(false)
			expect(await isUserBlockedFromPurchasing('buyer')).toBe(false)
			expect(await active()).not.toContain('content')
		})

		it('a bulk purchase cuts only its own rows, never the seat holders', async () => {
			await database
				.update(schema.purchases)
				.set({ bulkCouponId: 'bulk-fixture' })
				.where(eq(schema.purchases.id, 'disputed'))
			await database
				.update(schema.purchases)
				.set({ redeemedBulkCouponId: 'bulk-fixture' })
				.where(eq(schema.purchases.id, 'bystander-purchase'))
			await expect(apply('lost')).resolves.toMatchObject({ isBulk: true })
			expect((await purchase('bystander-purchase'))!.status).toBe('Valid')
			expect(await active()).toContain('bystander-content')
			expect(await isUserBlockedFromPurchasing('bystander')).toBe(false)
		})

		it('an upgrade dispute leaves the separately paid source purchase', async () => {
			await database
				.update(schema.purchases)
				.set({ upgradedFromId: 'other-product' })
				.where(eq(schema.purchases.id, 'disputed'))
			await apply('lost')
			expect((await purchase('other-product'))!.status).toBe('Valid')
			expect(await active()).toContain('other-product-content')
		})

		it('a legacy Banned status alone never blocks the user', async () => {
			await setStatus('Banned')
			expect(await isUserBlockedFromPurchasing('buyer')).toBe(false)
		})
	})

	describe('discord roles', () => {
		it('removes a role no live grant supports and records it', async () => {
			await apply('opened')
			const discord = fakeDiscord()
			await expect(syncRole(discord.client)).resolves.toEqual({
				kind: 'synced',
				roleId: 'role-1',
				result: 'removed',
			})
			expect(discord.calls).toEqual(['remove role-1'])
			expect((await record())!.discordSync).toEqual({
				'role-1': { result: 'removed', at: NOW.toISOString() },
			})
		})

		it('regression: keeps a role another live purchase still grants', async () => {
			await database.insert(schema.entitlements).values({
				id: 'surviving-discord',
				userId: 'buyer',
				sourceType: 'PURCHASE',
				sourceId: 'other-product',
				entitlementType: 'discord-type',
				metadata: { discordRoleId: 'role-1' },
			})
			await apply('opened')
			const discord = fakeDiscord()
			await expect(syncRole(discord.client)).resolves.toMatchObject({
				result: 'kept',
			})
			expect(discord.calls).toEqual([])
			expect(discord.roles.has('role-1')).toBe(true)
		})

		it('regression: a removal step retried after a win restores instead of removing', async () => {
			await apply('opened')
			const discord = fakeDiscord()
			await syncRole(discord.client)
			await apply('won')
			// The opened run's step, retried late, reads the won state.
			await expect(syncRole(discord.client)).resolves.toMatchObject({
				result: 'restored',
			})
			expect(discord.calls).toEqual(['remove role-1', 'add role-1'])
			expect(discord.roles.has('role-1')).toBe(true)
		})

		it('does not add a role on a win that the dispute never removed', async () => {
			await apply('opened')
			const discord = fakeDiscord([])
			await expect(syncRole(discord.client)).resolves.toMatchObject({
				result: 'absent',
			})
			await apply('won')
			await expect(syncRole(discord.client)).resolves.toMatchObject({
				result: 'kept',
			})
			expect(discord.calls).toEqual([])
		})

		it('a Discord failure throws and records nothing so Inngest retries', async () => {
			await apply('opened')
			const discord = fakeDiscord()
			discord.client.removeRole = async () => {
				throw new Error('discord remove role failed: 503')
			}
			await expect(syncRole(discord.client)).rejects.toThrow('503')
			expect((await record())!.discordSync).toEqual({})
		})

		it('an unconfirmed removal throws', async () => {
			await apply('opened')
			const discord = fakeDiscord()
			discord.client.removeRole = async () => {}
			await expect(syncRole(discord.client)).rejects.toThrow(
				'not confirmed by readback',
			)
		})
	})

	describe('backfill', () => {
		it('preview plans exactly what applying a loss changes and writes nothing', async () => {
			const input = {
				purchaseId: 'disputed',
				stripeDisputeId: 'du_1',
				previousStatus: 'Restricted',
				event: 'lost' as const,
			}
			const preview = await previewDisputeEvent(input)
			expect(preview).toEqual({
				kind: 'applied',
				purchaseId: 'disputed',
				userId: 'buyer',
				status: 'Restricted',
				plannedStatus: 'Disputed',
				from: null,
				to: 'lost',
				originalStatus: 'Restricted',
				cutEntitlementIds: ['content', 'discord'],
				cutCreditEntitlementIds: ['credit'],
				restoreEntitlementIds: [],
				discordRoleIds: ['role-1'],
				buyer: { kind: 'resolved', userId: 'buyer', transferred: false },
				buyerAlreadyBlocked: false,
				isBulk: false,
			})
			expect((await purchase('disputed'))!.status).toBe('Restricted')
			expect(await active()).toContain('content')

			const { buyerAlreadyBlocked: _, ...planned } =
				preview as typeof preview & {
					buyerAlreadyBlocked?: boolean
				}
			const applied = await applyDisputeEvent({ ...input, now: NOW })
			expect(applied).toMatchObject(planned)
			await expect(previewDisputeEvent(input)).resolves.toMatchObject({
				kind: 'unchanged',
				to: 'lost',
			})
		})

		it('readback confirms only the exact lost outcome with Discord settled', async () => {
			await apply('opened')
			// A block from an earlier dispute plus an open record is not proof.
			await database
				.update(schema.users)
				.set({
					fields: {
						purchaseBlock: {
							reason: 'chargeback_lost',
							purchaseId: 'older',
							stripeDisputeId: 'du_0',
							blockedAt: NOW.toISOString(),
						},
					},
				})
				.where(eq(schema.users.id, 'buyer'))
			let readback = await readDisputeState('disputed')
			expect(lostDisputeConfirmed(readback, 'du_1')).toBe(false)

			await apply('lost')
			readback = await readDisputeState('disputed')
			expect(readback.discordPending).toEqual(['role-1'])
			expect(lostDisputeConfirmed(readback, 'du_1')).toBe(false)

			await syncRole(fakeDiscord().client)
			readback = await readDisputeState('disputed')
			expect(readback).toMatchObject({
				status: 'Disputed',
				liveCutEntitlementIds: [],
				buyerBlocked: true,
				discordPending: [],
			})
			expect(lostDisputeConfirmed(readback, 'du_1')).toBe(true)
			expect(lostDisputeConfirmed(readback, 'du_other')).toBe(false)
		})
	})
})
