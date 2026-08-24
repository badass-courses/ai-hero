import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import * as schema from '@/db/schema'

import {
	createDrizzleTeamPurchaseFulfillmentDataSource,
	type TeamPurchaseLinkInput,
} from './team-purchase-fulfillment'
import {
	connectToDisposableMySqlServer,
	createDisposableDatabaseName,
} from './team-purchase-mysql-test-guard'

const mysqlUrl = process.env.AIH_TEAM_FULFILLMENT_MYSQL_URL
const describeWithMySql = mysqlUrl ? describe : describe.skip

type PurchaseRow = RowDataPacket & {
	id: string
	organizationId: string | null
	organizationMembershipId: string | null
}

describeWithMySql('team purchase real MySQL concurrency', () => {
	let adminPool: Pool
	let pool: Pool
	let disposableDatabaseName: string
	let source: ReturnType<
		typeof createDrizzleTeamPurchaseFulfillmentDataSource
	>

	beforeAll(async () => {
		const connection = await connectToDisposableMySqlServer(
			mysqlUrl!,
			{
				nodeEnv: process.env.NODE_ENV,
				vercelEnv: process.env.VERCEL_ENV,
			},
			async (safeServerUrl) => ({
				adminPool: mysql.createPool({
					uri: safeServerUrl.toString(),
					connectionLimit: 2,
				}),
				safeServerUrl,
			}),
		)
		adminPool = connection.adminPool
		disposableDatabaseName = createDisposableDatabaseName()
		await adminPool.query(
			`CREATE DATABASE \`${disposableDatabaseName}\``,
		)
		const disposableUrl = new URL(connection.safeServerUrl)
		disposableUrl.pathname = `/${disposableDatabaseName}`
		pool = mysql.createPool({
			uri: disposableUrl.toString(),
			connectionLimit: 4,
		})
		await pool.query(`
			CREATE TABLE AI_Coupon (
				id VARCHAR(191) PRIMARY KEY,
				organizationId VARCHAR(191) NULL,
				code VARCHAR(191) NULL,
				createdAt TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
				expires TIMESTAMP(3) NULL,
				fields JSON NULL,
				maxUses INT NOT NULL DEFAULT -1,
				\`default\` BOOLEAN NOT NULL DEFAULT FALSE,
				merchantCouponId VARCHAR(191) NULL,
				status INT NOT NULL DEFAULT 0,
				usedCount INT NOT NULL DEFAULT 0,
				percentageDiscount DECIMAL(3,2) NULL,
				amountDiscount INT NULL,
				restrictedToProductId VARCHAR(191) NULL
			)
		`)
		await pool.query(`
			CREATE TABLE AI_Purchase (
				id VARCHAR(191) PRIMARY KEY,
				userId VARCHAR(191) NULL,
				organizationMembershipId VARCHAR(191) NULL,
				organizationId VARCHAR(191) NULL,
				createdAt TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
				totalAmount DECIMAL(65,30) NOT NULL DEFAULT 0,
				ip_address VARCHAR(191) NULL,
				city VARCHAR(191) NULL,
				state VARCHAR(191) NULL,
				country VARCHAR(191) NULL,
				couponId VARCHAR(191) NULL,
				productId VARCHAR(191) NOT NULL DEFAULT 'product-team',
				merchantChargeId VARCHAR(191) NULL,
				upgradedFromId VARCHAR(191) NULL,
				status VARCHAR(191) NOT NULL DEFAULT 'Valid',
				bulkCouponId VARCHAR(191) NULL,
				merchantSessionId VARCHAR(191) NULL,
				redeemedBulkCouponId VARCHAR(191) NULL,
				fields JSON NULL
			)
		`)
		await pool.query(`
			CREATE TABLE AI_OrganizationMembership (
				id VARCHAR(255) PRIMARY KEY,
				organizationId VARCHAR(191) NULL,
				role VARCHAR(191) NOT NULL DEFAULT 'user',
				invitedById VARCHAR(255) NOT NULL,
				userId VARCHAR(255) NOT NULL,
				personalOrganizationUserId VARCHAR(255) NULL,
				fields JSON NULL,
				createdAt TIMESTAMP(3) NULL DEFAULT CURRENT_TIMESTAMP(3)
			)
		`)
		await pool.query(`
			CREATE TABLE AI_Role (
				id VARCHAR(255) PRIMARY KEY,
				organizationId VARCHAR(191) NULL,
				name VARCHAR(255) NOT NULL,
				description TEXT NULL,
				active BOOLEAN NOT NULL DEFAULT TRUE,
				createdAt TIMESTAMP(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
				updatedAt TIMESTAMP(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
				deletedAt TIMESTAMP(3) NULL
			)
		`)
		await pool.query(`
			CREATE TABLE AI_OrganizationMembershipRole (
				organizationMembershipId VARCHAR(255) NOT NULL,
				roleId VARCHAR(255) NOT NULL,
				active BOOLEAN NOT NULL DEFAULT TRUE,
				organizationId VARCHAR(191) NULL,
				createdAt TIMESTAMP(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
				updatedAt TIMESTAMP(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
				deletedAt TIMESTAMP(3) NULL,
				PRIMARY KEY (organizationMembershipId, roleId)
			)
		`)

		const database = drizzle(pool, { schema, mode: 'planetscale' })
		source = createDrizzleTeamPurchaseFulfillmentDataSource(
			database as unknown as Parameters<
				typeof createDrizzleTeamPurchaseFulfillmentDataSource
			>[0],
		)
	})

	afterAll(async () => {
		await pool?.end()
		if (adminPool && disposableDatabaseName) {
			await adminPool.query(
				`DROP DATABASE \`${disposableDatabaseName}\``,
			)
			await adminPool.end()
		}
	})

	it('serializes original and add-seat links on the indexed coupon row and leaves one team card', async () => {
		await pool.query(
			`INSERT INTO AI_Coupon (id, organizationId, maxUses, usedCount, status)
			 VALUES ('coupon-team', 'organization-team', 9, 7, 1)`,
		)
		await pool.query(
			`INSERT INTO AI_OrganizationMembership
			 (id, organizationId, invitedById, userId)
			 VALUES ('membership-manager', 'organization-team', 'buyer', 'buyer')`,
		)
		await pool.query(
			`INSERT INTO AI_Role (id, organizationId, name, active)
			 VALUES ('role-owner', 'organization-team', 'owner', TRUE)`,
		)
		await pool.query(
			`INSERT INTO AI_OrganizationMembershipRole
			 (organizationMembershipId, roleId, active, organizationId)
			 VALUES ('membership-manager', 'role-owner', TRUE, 'organization-team')`,
		)
		await pool.query(
			`INSERT INTO AI_Purchase
			 (id, userId, createdAt, bulkCouponId)
			 VALUES
			 ('purchase-original', 'buyer', '2026-08-19 09:00:00.000', 'coupon-team'),
			 ('purchase-add-seats', 'buyer', '2026-08-19 10:00:00.000', 'coupon-team')`,
		)

		const baseInput = {
			bulkCouponId: 'coupon-team',
			expectedPurchaseStatus: 'Valid',
			expectedPurchaseOrganizationId: null,
			expectedPurchaseMembershipId: null,
			expectedCouponOrganizationId: 'organization-team',
			targetOrganizationId: 'organization-team',
			targetMembershipId: 'membership-manager',
			userId: 'buyer',
		}
		const originalPurchase = await source.loadPurchase('purchase-original')
		const addSeatPurchase = await source.loadPurchase('purchase-add-seats')
		if (!originalPurchase || !addSeatPurchase) {
			throw new Error('integration fixture purchases missing')
		}
		const originalInput: TeamPurchaseLinkInput = {
			...baseInput,
			purchaseId: 'purchase-original',
			expectedPurchaseCreatedAt: originalPurchase.createdAt,
		}
		const addSeatInput: TeamPurchaseLinkInput = {
			...baseInput,
			purchaseId: 'purchase-add-seats',
			expectedPurchaseCreatedAt: addSeatPurchase.createdAt,
		}

		const results = await Promise.all([
			source.commitLink(addSeatInput),
			source.commitLink(originalInput),
		])
		const [rows] = await pool.query<PurchaseRow[]>(
			`SELECT id, organizationId, organizationMembershipId
			 FROM AI_Purchase ORDER BY createdAt`,
		)

		expect(results.map((result) => result.status).sort()).toEqual([
			'add-seat-extension',
			'linked',
		])
		expect(rows).toEqual([
			{
				id: 'purchase-original',
				organizationId: 'organization-team',
				organizationMembershipId: 'membership-manager',
			},
			{
				id: 'purchase-add-seats',
				organizationId: null,
				organizationMembershipId: null,
			},
		])
	})
})
