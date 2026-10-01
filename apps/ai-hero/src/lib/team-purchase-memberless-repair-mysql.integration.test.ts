import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

vi.mock('@/db', () => ({ db: {} }))
import * as schema from '@/db/schema'
import { getManagedOrganizationIds } from '@/lib/team-purchases'
import {
	connectToDisposableMySqlServer,
	createDisposableDatabaseName,
} from './team-purchase-mysql-test-guard'
import {
	applyMemberlessTeamPurchaseRepair,
	createMemberlessRepairDataSource,
	previewMemberlessTeamPurchaseRepair,
	type MemberlessRepairPlan,
} from './team-purchase-memberless-repair'

// No DATABASE_URL fallback. Existing guard rejects nonloopback, standard port,
// non-root, missing test password and production environments before connecting.
const url = process.env.AIH_TEAM_REPAIR_MYSQL_URL
const suite = url ? describe : describe.skip

suite('memberless repair isolated real MySQL transactions', () => {
	let admin: Pool
	let pool: Pool
	let name: string
	let source: ReturnType<typeof createMemberlessRepairDataSource>
	let database: MySql2Database<typeof schema>

	beforeAll(async () => {
		const safe = await connectToDisposableMySqlServer(
			url!,
			{ nodeEnv: process.env.NODE_ENV, vercelEnv: process.env.VERCEL_ENV },
			(safe) => safe,
		)
		admin = mysql.createPool({
			uri: safe.toString(),
			connectionLimit: 1,
			timezone: 'Z',
		})
		name = createDisposableDatabaseName()
		await admin.query(`CREATE DATABASE \`${name}\``)
		const disposable = new URL(safe)
		disposable.pathname = `/${name}`
		pool = mysql.createPool({
			uri: disposable.toString(),
			connectionLimit: 4,
			timezone: 'Z',
		})
		const ddl = [
			`CREATE TABLE AI_User (id VARCHAR(255) PRIMARY KEY, email VARCHAR(255))`,
			`CREATE TABLE AI_Organization (id VARCHAR(255) PRIMARY KEY, name VARCHAR(255), personalOrganizationUserId VARCHAR(255) UNIQUE, fields JSON, image VARCHAR(255), createdAt TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
			`CREATE TABLE AI_Coupon (
				id VARCHAR(191) PRIMARY KEY, organizationId VARCHAR(191), code VARCHAR(191), createdAt TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), expires TIMESTAMP(3) NULL,
				fields JSON, maxUses INT NOT NULL DEFAULT -1, \`default\` BOOLEAN NOT NULL DEFAULT FALSE, merchantCouponId VARCHAR(191), status INT NOT NULL DEFAULT 0, usedCount INT NOT NULL DEFAULT 0,
				percentageDiscount DECIMAL(3,2), amountDiscount INT, restrictedToProductId VARCHAR(191))`,
			`CREATE TABLE AI_Purchase (
				id VARCHAR(191) PRIMARY KEY, userId VARCHAR(191), organizationMembershipId VARCHAR(191), organizationId VARCHAR(191), createdAt TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
				totalAmount DECIMAL(65,30) NOT NULL DEFAULT 0, ip_address VARCHAR(191), city VARCHAR(191), state VARCHAR(191), country VARCHAR(191), couponId VARCHAR(191),
				productId VARCHAR(191) NOT NULL DEFAULT 'product-test', merchantChargeId VARCHAR(191), upgradedFromId VARCHAR(191), status VARCHAR(191) NOT NULL DEFAULT 'Valid', bulkCouponId VARCHAR(191),
				merchantSessionId VARCHAR(191), redeemedBulkCouponId VARCHAR(191), fields JSON)`,
			`CREATE TABLE AI_OrganizationMembership (
				id VARCHAR(255) PRIMARY KEY, organizationId VARCHAR(191), role VARCHAR(191) NOT NULL DEFAULT 'user', invitedById VARCHAR(255) NOT NULL, userId VARCHAR(255) NOT NULL,
				personalOrganizationUserId VARCHAR(255) UNIQUE, fields JSON, createdAt TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), INDEX idx_OrganizationMembership_on_userId(userId))`,
			`CREATE TABLE AI_Role (
				id VARCHAR(255) PRIMARY KEY, organizationId VARCHAR(191), name VARCHAR(255) NOT NULL, description TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
				createdAt TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), updatedAt TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), deletedAt TIMESTAMP(3) NULL, UNIQUE unique_name_per_org(organizationId,name))`,
			`CREATE TABLE AI_OrganizationMembershipRole (
				organizationMembershipId VARCHAR(255) NOT NULL, roleId VARCHAR(255) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, organizationId VARCHAR(191),
				createdAt TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), updatedAt TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), deletedAt TIMESTAMP(3) NULL,
				PRIMARY KEY (organizationMembershipId,roleId))`,
		]
		for (const sql of ddl) await pool.query(sql)
		database = drizzle(pool, { schema, mode: 'planetscale' })
		source = createMemberlessRepairDataSource(
			database as unknown as Parameters<
				typeof createMemberlessRepairDataSource
			>[0],
		)
	})

	beforeEach(async () => {
		for (const table of [
			'AI_OrganizationMembershipRole',
			'AI_Role',
			'AI_OrganizationMembership',
			'AI_Organization',
			'AI_Purchase',
			'AI_Coupon',
			'AI_User',
		])
			await pool.query(`DELETE FROM ${table}`)
		await pool.query(
			`INSERT INTO AI_User(id,email) VALUES ('buyer-test','buyer@example.test')`,
		)
		await pool.query(
			`INSERT INTO AI_Coupon(id,status,maxUses,usedCount) VALUES ('coupon-test',1,2,0)`,
		)
		await pool.query(`INSERT INTO AI_Purchase(id,userId,bulkCouponId,status,country,totalAmount,merchantChargeId,fields)
			VALUES ('purchase-test','buyer-test','coupon-test','Valid','CZ',399,'charge-test',JSON_OBJECT('billingUserId','payer-test'))`)
	})

	afterAll(async () => {
		await pool?.end()
		if (admin && name) await admin.query(`DROP DATABASE \`${name}\``)
		await admin?.end()
	})

	async function plan(): Promise<MemberlessRepairPlan> {
		const preview = await previewMemberlessTeamPurchaseRepair(
			'purchase-test',
			source,
		)
		if (preview.status !== 'ready')
			throw new Error(`Preview held: ${preview.reason}`)
		return preview.plan
	}
	function apply(p: MemberlessRepairPlan) {
		return applyMemberlessTeamPurchaseRepair(
			p,
			{
				allowWrite: true,
				confirmCount: 1,
				purchaseId: p.purchaseId,
				approvedPlanHash: p.approvalHash,
			},
			source,
		)
	}
	async function organizations() {
		const [rows] = await pool.query<RowDataPacket[]>(
			'SELECT COUNT(*) AS count FROM AI_Organization',
		)
		return Number(rows[0]!.count)
	}

	it('previews zero writes, atomically creates one owner and links only the pool, then replays without duplication', async () => {
		const p = await plan()
		expect(await organizations()).toBe(0)
		expect(await apply(p)).toMatchObject({
			status: 'repaired',
			verified: true,
		})
		expect(await apply(p)).toMatchObject({
			status: 'already-repaired',
			verified: true,
			writesCommitted: false,
		})
		expect(await organizations()).toBe(1)
		const current = await source.loadSnapshot(p.purchaseId)
		expect(current.purchase).toMatchObject({
			country: 'CZ',
			status: 'Valid',
			merchantChargeId: 'charge-test',
			fields: { billingUserId: 'payer-test' },
		})
		expect(current.coupon).toMatchObject({
			maxUses: 2,
			usedCount: 0,
			status: 1,
		})
		const members = await database.query.organizationMemberships.findMany({
			with: { organizationMembershipRoles: { with: { role: true } } },
		})
		expect(
			getManagedOrganizationIds(
				members.map((m) => ({
					organizationId: m.organizationId!,
					organizationMembershipRoles: m.organizationMembershipRoles,
				})),
			),
		).toEqual([p.organizationId])
	})

	it('serializes concurrent retries into one bootstrap and one no-op', async () => {
		const p = await plan()
		const results = await Promise.all([apply(p), apply(p)])
		expect(results.map((r) => r.status).sort()).toEqual([
			'already-repaired',
			'repaired',
		])
		expect(await organizations()).toBe(1)
	})

	it.each([
		`UPDATE AI_Purchase SET status='Refunded' WHERE id='purchase-test'`,
		`UPDATE AI_Purchase SET country='US' WHERE id='purchase-test'`,
		`UPDATE AI_Purchase SET totalAmount=1 WHERE id='purchase-test'`,
		`UPDATE AI_Purchase SET userId='other-buyer' WHERE id='purchase-test'`,
		`UPDATE AI_Coupon SET usedCount=1 WHERE id='coupon-test'`,
		`INSERT INTO AI_OrganizationMembership(id,userId,invitedById) VALUES ('existing-member','buyer-test','buyer-test')`,
		`INSERT INTO AI_Purchase(id,userId,bulkCouponId) VALUES ('add-seats','buyer-test','coupon-test')`,
	])('rejects expected-state drift before writes: %s', async (sql) => {
		const p = await plan()
		await pool.query(sql)
		await expect(apply(p)).rejects.toThrow('expected state changed')
		expect(await organizations()).toBe(0)
	})

	it('rolls back organization and membership inserts when a later role insert fails', async () => {
		const p = await plan()
		await pool.query('INSERT INTO AI_Role(id,name) VALUES (?,?)', [
			p.ownerRoleId,
			'unrelated-role',
		])
		await expect(apply(p)).rejects.toThrow()
		expect(await organizations()).toBe(0)
		const [rows] = await pool.query<RowDataPacket[]>(
			'SELECT COUNT(*) AS count FROM AI_OrganizationMembership',
		)
		expect(Number(rows[0]!.count)).toBe(0)
	})

	it('requires a fresh preview for an unapplied expired plan', async () => {
		const p = await plan()
		await expect(
			source.commit({
				...p,
				createdAt: new Date(Date.now() - 16 * 60_000).toISOString(),
			}),
		).rejects.toThrow('preview expired')
		expect(await organizations()).toBe(0)
	})

	it('does not restore an inactive owner grant on replay', async () => {
		const p = await plan()
		await apply(p)
		await pool.query(
			'UPDATE AI_OrganizationMembershipRole SET active=FALSE WHERE roleId=?',
			[p.ownerRoleId],
		)
		await expect(apply(p)).rejects.toThrow('expected state changed')
		const [rows] = await pool.query<RowDataPacket[]>(
			'SELECT active FROM AI_OrganizationMembershipRole WHERE roleId=?',
			[p.ownerRoleId],
		)
		expect(rows[0]!.active).toBe(0)
	})
})
