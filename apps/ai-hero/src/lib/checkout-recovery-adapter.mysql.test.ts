import { mysqlTable } from '@/db/mysql-table'
import { preserveQueryResultShape } from '@/db/mysql-query-client'
import * as schema from '@/db/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	type MySqlDatabase,
	type MySqlQueryResultHKT,
} from 'drizzle-orm/mysql-core'
import { drizzle, type MySql2PreparedQueryHKT } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'

import { DrizzleAdapter } from '@coursebuilder/adapter-drizzle'

const mysqlUrl = process.env.AIH_CHECKOUT_RECOVERY_MYSQL_URL
const describeMysql = mysqlUrl ? describe : describe.skip

function createPool(uri: string) {
	const pool = preserveQueryResultShape(
		mysql.createPool({ uri, connectionLimit: 2, timezone: 'Z' }),
	)
	const getConnection = pool.getConnection.bind(pool)
	pool.getConnection = (async () =>
		preserveQueryResultShape(await getConnection())) as typeof pool.getConnection
	return pool
}

async function createSchema(pool: Pool) {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS AI_User (
			id varchar(255) PRIMARY KEY,
			name varchar(255) NULL,
			role varchar(191) NOT NULL DEFAULT 'user',
			email varchar(255) NOT NULL UNIQUE,
			fields json NULL,
			emailVerified timestamp(3) NULL,
			image varchar(255) NULL,
			createdAt timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3)
		)
	`)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS AI_Product (
			id varchar(191) PRIMARY KEY,
			organizationId varchar(191) NULL,
			name varchar(191) NOT NULL,
			\`key\` varchar(191) NULL,
			type varchar(191) NULL,
			fields json NULL,
			createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			status int NOT NULL DEFAULT 0,
			quantityAvailable int NOT NULL DEFAULT -1
		)
	`)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS AI_MerchantCharge (
			id varchar(191) PRIMARY KEY,
			organizationId varchar(191) NULL,
			status int NOT NULL DEFAULT 0,
			identifier varchar(191) NOT NULL UNIQUE,
			userId varchar(191) NOT NULL,
			merchantAccountId varchar(191) NOT NULL,
			merchantProductId varchar(191) NOT NULL,
			merchantSubscriptionId varchar(191) NULL,
			createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			merchantCustomerId varchar(191) NOT NULL
		)
	`)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS AI_MerchantSession (
			id varchar(191) PRIMARY KEY,
			organizationId varchar(191) NULL,
			identifier varchar(191) NOT NULL,
			merchantAccountId varchar(191) NOT NULL
		)
	`)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS AI_MerchantCoupon (
			id varchar(191) PRIMARY KEY,
			identifier varchar(191) NULL UNIQUE,
			organizationId varchar(191) NULL,
			status int NOT NULL DEFAULT 0,
			merchantAccountId varchar(191) NOT NULL,
			percentageDiscount decimal(3,2) NULL,
			amountDiscount int NULL,
			type varchar(191) NULL
		)
	`)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS AI_Coupon (
			id varchar(191) PRIMARY KEY,
			organizationId varchar(191) NULL,
			code varchar(191) NULL UNIQUE,
			createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			expires timestamp(3) NULL,
			fields json NULL,
			maxUses int NOT NULL DEFAULT -1,
			\`default\` boolean NOT NULL DEFAULT false,
			merchantCouponId varchar(191) NULL,
			status int NOT NULL DEFAULT 0,
			usedCount int NOT NULL DEFAULT 0,
			percentageDiscount decimal(3,2) NULL,
			amountDiscount int NULL,
			restrictedToProductId varchar(191) NULL
		)
	`)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS AI_Purchase (
			id varchar(191) PRIMARY KEY,
			userId varchar(191) NULL,
			organizationMembershipId varchar(191) NULL,
			organizationId varchar(191) NULL,
			createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			totalAmount decimal(65,30) NOT NULL,
			ip_address varchar(191) NULL,
			city varchar(191) NULL,
			state varchar(191) NULL,
			country varchar(191) NULL,
			couponId varchar(191) NULL,
			productId varchar(191) NOT NULL,
			merchantChargeId varchar(191) NULL,
			upgradedFromId varchar(191) NULL UNIQUE,
			status varchar(191) NOT NULL DEFAULT 'Valid',
			bulkCouponId varchar(191) NULL,
			merchantSessionId varchar(191) NULL,
			redeemedBulkCouponId varchar(191) NULL,
			fields json NULL
		)
	`)
	await pool.query(`
		CREATE TABLE IF NOT EXISTS AI_PurchaseUserTransfer (
			id varchar(191) PRIMARY KEY,
			transferState enum('AVAILABLE','INITIATED','VERIFIED','CANCELED','EXPIRED','CONFIRMED','COMPLETED') NOT NULL DEFAULT 'AVAILABLE',
			purchaseId varchar(191) NOT NULL,
			organizationId varchar(191) NULL,
			sourceUserId varchar(191) NOT NULL,
			targetUserId varchar(191) NULL,
			createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			expiresAt timestamp(3) NULL,
			canceledAt timestamp(3) NULL,
			confirmedAt timestamp(3) NULL,
			completedAt timestamp(3) NULL
		)
	`)
}

const options = {
	userId: 'user_recovery',
	productId: 'product_recovery',
	stripeChargeId: 'ch_recovery',
	stripeCouponId: undefined,
	merchantAccountId: 'ma_recovery',
	merchantProductId: 'mp_recovery',
	merchantCustomerId: 'mcu_recovery',
	stripeChargeAmount: 19_900,
	quantity: 1,
	checkoutSessionId: 'cs_recovery',
	appliedPPPStripeCouponId: undefined,
	upgradedFromPurchaseId: undefined,
	usedCouponId: undefined,
}

type TcpQueryResult = {
	insertId: string
	rows: Record<string, unknown>[]
	rowsAffected: number
}

interface TcpQueryResultHKT extends MySqlQueryResultHKT {
	readonly type: TcpQueryResult
}

type RecoveryDatabase = MySqlDatabase<
	TcpQueryResultHKT,
	MySql2PreparedQueryHKT,
	typeof schema
>

interface CountRow extends RowDataPacket {
	chargeCount: number
	sessionCount: number
	purchaseCount: number
	transferCount: number
}

describeMysql('checkout recovery adapter MySQL regression', () => {
	let pool: Pool
	let adapter: ReturnType<typeof DrizzleAdapter>

	beforeAll(async () => {
		pool = createPool(mysqlUrl!)
		await createSchema(pool)
		const database = drizzle(pool, {
			schema,
			mode: 'planetscale',
		}) as unknown as RecoveryDatabase
		adapter = DrizzleAdapter<RecoveryDatabase>(
			database,
			mysqlTable,
			{} as never,
		)
	})

	beforeEach(async () => {
		await pool.query('DELETE FROM AI_PurchaseUserTransfer')
		await pool.query('DELETE FROM AI_Purchase')
		await pool.query('DELETE FROM AI_MerchantSession')
		await pool.query('DELETE FROM AI_MerchantCharge')
		await pool.query(
			`INSERT INTO AI_MerchantCharge
				(id, identifier, userId, merchantAccountId, merchantProductId, merchantCustomerId)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				'mc_recovery',
				options.stripeChargeId,
				options.userId,
				options.merchantAccountId,
				options.merchantProductId,
				options.merchantCustomerId,
			],
		)
		await pool.query(
			`INSERT INTO AI_MerchantSession
				(id, identifier, merchantAccountId)
			 VALUES (?, ?, ?)`,
			['ms_recovery', options.checkoutSessionId, options.merchantAccountId],
		)
	})

	afterAll(async () => {
		await pool?.end()
	})

	it('adopts the existing charge and session and creates one purchase', async () => {
		const first = await adapter.createMerchantChargeAndPurchase(options)
		const second = await adapter.createMerchantChargeAndPurchase(options)

		expect(second.id).toBe(first.id)
		expect(first.merchantChargeId).toBe('mc_recovery')
		expect(first.merchantSessionId).toBe('ms_recovery')

		const [[counts]] = await pool.query<CountRow[]>(`
			SELECT
				(SELECT COUNT(*) FROM AI_MerchantCharge) AS chargeCount,
				(SELECT COUNT(*) FROM AI_MerchantSession) AS sessionCount,
				(SELECT COUNT(*) FROM AI_Purchase) AS purchaseCount,
				(SELECT COUNT(*) FROM AI_PurchaseUserTransfer) AS transferCount
		`)
		expect(counts).toEqual({
			chargeCount: 1,
			sessionCount: 1,
			purchaseCount: 1,
			transferCount: 1,
		})
	})

	it('rejects a mismatched existing charge before adopting it', async () => {
		await pool.query(
			'UPDATE AI_MerchantCharge SET userId = ? WHERE identifier = ?',
			['user_other', options.stripeChargeId],
		)

		await expect(
			adapter.createMerchantChargeAndPurchase(options),
		).rejects.toThrow('CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_V1')

		const [[counts]] = await pool.query<CountRow[]>(`
			SELECT
				(SELECT COUNT(*) FROM AI_MerchantCharge) AS chargeCount,
				(SELECT COUNT(*) FROM AI_MerchantSession) AS sessionCount,
				(SELECT COUNT(*) FROM AI_Purchase) AS purchaseCount,
				(SELECT COUNT(*) FROM AI_PurchaseUserTransfer) AS transferCount
		`)
		expect(counts).toEqual({
			chargeCount: 1,
			sessionCount: 1,
			purchaseCount: 0,
			transferCount: 0,
		})
	})

	it('rejects a mismatch before returning an existing Purchase', async () => {
		const existingPurchase = await adapter.createMerchantChargeAndPurchase(options)

		await expect(
			adapter.createMerchantChargeAndPurchase({
				...options,
				userId: 'user_other',
			}),
		).rejects.toThrow('CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_V1')

		const [[counts]] = await pool.query<CountRow[]>(`
			SELECT
				(SELECT COUNT(*) FROM AI_MerchantCharge) AS chargeCount,
				(SELECT COUNT(*) FROM AI_MerchantSession) AS sessionCount,
				(SELECT COUNT(*) FROM AI_Purchase) AS purchaseCount,
				(SELECT COUNT(*) FROM AI_PurchaseUserTransfer) AS transferCount
		`)
		expect(existingPurchase.id).toMatch(/^purch_/)
		expect(counts).toEqual({
			chargeCount: 1,
			sessionCount: 1,
			purchaseCount: 1,
			transferCount: 1,
		})
	})
})
