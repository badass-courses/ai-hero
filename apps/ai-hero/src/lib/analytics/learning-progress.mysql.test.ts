import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import mysql, { type Connection, type Pool } from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import type { SQL } from 'drizzle-orm'

import { preserveQueryResultShape } from '@/db/mysql-query-client'

import {
	expectedLearningProgress,
	LEARNING_AS_OF,
	learningFixture,
} from './learning-progress.fixtures'
import {
	LearningProductNotFoundError,
	readLearningProgress,
} from './learning-progress-query'

vi.mock('@/db', () => ({}))

const url = process.env.AIH_MYSQL_TEST_URL

/** Columns the queries read, with the production key names. */
const ddl = [
	`CREATE TABLE AI_Product (id varchar(191) NOT NULL PRIMARY KEY, name varchar(191) NOT NULL, type varchar(191))`,
	`CREATE TABLE AI_ContentResource (id varchar(255) NOT NULL PRIMARY KEY, type varchar(255) NOT NULL, fields json, deletedAt timestamp(3) NULL)`,
	`CREATE TABLE AI_ContentResourceProduct (productId varchar(255) NOT NULL, resourceId varchar(255) NOT NULL, position double NOT NULL DEFAULT 0, deletedAt timestamp(3) NULL, PRIMARY KEY (productId, resourceId), KEY resourceId_idx (resourceId))`,
	`CREATE TABLE AI_ContentResourceResource (resourceOfId varchar(255) NOT NULL, resourceId varchar(255) NOT NULL, position double NOT NULL DEFAULT 0, deletedAt timestamp(3) NULL, PRIMARY KEY (resourceOfId, resourceId), KEY contentResourceId_idx (resourceOfId), KEY resourceId_idx (resourceId))`,
	`CREATE TABLE AI_User (id varchar(255) NOT NULL PRIMARY KEY, emailVerified timestamp(3) NULL)`,
	`CREATE TABLE AI_Account (provider varchar(255) NOT NULL, providerAccountId varchar(255) NOT NULL, userId varchar(255) NOT NULL, PRIMARY KEY (provider, providerAccountId), KEY userId_idx (userId))`,
	`CREATE TABLE AI_Session (sessionToken varchar(255) NOT NULL PRIMARY KEY, userId varchar(255) NOT NULL, expires timestamp NOT NULL, KEY userId_idx (userId))`,
	`CREATE TABLE AI_Coupon (id varchar(191) NOT NULL PRIMARY KEY, maxUses int NOT NULL DEFAULT -1, usedCount int NOT NULL DEFAULT 0)`,
	`CREATE TABLE AI_Purchase (id varchar(191) NOT NULL PRIMARY KEY, userId varchar(191), productId varchar(191) NOT NULL, status varchar(191) NOT NULL DEFAULT 'Valid', totalAmount decimal(65,30) NOT NULL, bulkCouponId varchar(191), redeemedBulkCouponId varchar(191), KEY idx_Purchase_on_userId_status_productId (userId, status, productId), KEY idx_Purchase_on_productId (productId))`,
	`CREATE TABLE AI_PurchaseUserTransfer (id varchar(191) NOT NULL PRIMARY KEY, transferState enum('AVAILABLE','INITIATED','VERIFIED','CANCELED','EXPIRED','CONFIRMED','COMPLETED') NOT NULL DEFAULT 'AVAILABLE', purchaseId varchar(191) NOT NULL, sourceUserId varchar(191) NOT NULL, targetUserId varchar(191), KEY idx_PurchaseUserTransfer_on_purchaseId (purchaseId))`,
	`CREATE TABLE AI_ResourceProgress (userId varchar(255) NOT NULL, resourceId varchar(255) NOT NULL, completedAt datetime(3), updatedAt datetime(3), createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (userId, resourceId), KEY contentResourceId_idx (resourceId), KEY resourceId_idx (userId))`,
]

// Own disposable database only. Never touch the URL's database or existing tables.
describe.skipIf(!url)('learning progress SQL (synthetic MySQL)', () => {
	let connection: Connection
	let pool: Pool
	let databaseName: string
	let execute: (query: SQL) => Promise<unknown>

	beforeAll(async () => {
		const target = new URL(url!)
		if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
			throw new Error('MySQL fixtures must be local')
		const prefix = target.pathname.slice(1).replace(/_app$/, '') || 'aih'
		if (!/^[a-zA-Z0-9_]+$/.test(prefix))
			throw new Error('Invalid fixture database prefix')
		databaseName = `${prefix}_learning_${process.pid}_${Date.now()}`
		connection = await mysql.createConnection({ uri: url!, timezone: 'Z' })
		await connection.query(`CREATE DATABASE \`${databaseName}\``)
		await connection.query(`USE \`${databaseName}\``)
		// DATETIME progress columns must not drift with the session zone.
		await connection.query("SET time_zone = '-08:00'")
		for (const statement of ddl) await connection.query(statement)

		const f = learningFixture
		await connection.query('INSERT INTO AI_Product VALUES (?, ?, ?)', [
			f.productId,
			f.product.name,
			f.product.type,
		])
		for (const resource of f.resources)
			await connection.query(
				'INSERT INTO AI_ContentResource (id, type, fields) VALUES (?, ?, ?)',
				[resource.id, resource.type, JSON.stringify(resource.fields)],
			)
		await connection.query(
			'INSERT INTO AI_ContentResourceProduct (productId, resourceId) VALUES (?, ?)',
			[f.productId, 'cohort'],
		)
		for (const [parent, child, position, deleted] of f.links)
			await connection.query(
				`INSERT INTO AI_ContentResourceResource VALUES (?, ?, ?, ${deleted ? 'CURRENT_TIMESTAMP(3)' : 'NULL'})`,
				[parent, child, position],
			)
		for (const user of f.users) {
			await connection.query('INSERT INTO AI_User VALUES (?, ?)', [
				user.id,
				user.emailVerified,
			])
			if ('account' in user)
				await connection.query('INSERT INTO AI_Account VALUES (?, ?, ?)', [
					'github',
					`gh-${user.id}`,
					user.id,
				])
			if ('session' in user)
				await connection.query(
					'INSERT INTO AI_Session VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)',
					[`session-${user.id}`, user.id],
				)
		}
		for (const coupon of f.coupons)
			await connection.query('INSERT INTO AI_Coupon VALUES (?, ?, ?)', [
				coupon.id,
				coupon.maxUses,
				coupon.usedCount,
			])
		for (const purchase of f.purchases)
			await connection.query(
				'INSERT INTO AI_Purchase VALUES (?, ?, ?, ?, ?, ?, ?)',
				[
					purchase.id,
					purchase.userId,
					'productId' in purchase ? purchase.productId : f.productId,
					purchase.status,
					'totalAmount' in purchase ? purchase.totalAmount : 199,
					'bulkCouponId' in purchase ? purchase.bulkCouponId : null,
					'redeemedBulkCouponId' in purchase
						? purchase.redeemedBulkCouponId
						: null,
				],
			)
		for (const transfer of f.transfers)
			await connection.query(
				'INSERT INTO AI_PurchaseUserTransfer VALUES (?, ?, ?, ?, ?)',
				[
					transfer.id,
					transfer.transferState,
					transfer.purchaseId,
					transfer.sourceUserId,
					transfer.targetUserId,
				],
			)
		for (const [userId, lessonId, createdAt, completedAt] of f.progress)
			await connection.query(
				'INSERT INTO AI_ResourceProgress (userId, resourceId, createdAt, completedAt) VALUES (?, ?, ?, ?)',
				[userId, lessonId, createdAt, completedAt],
			)
		// One connection, so the session zone below holds for every read.
		target.pathname = `/${databaseName}`
		pool = preserveQueryResultShape(
			mysql.createPool({
				uri: target.toString(),
				connectionLimit: 1,
				timezone: 'Z',
			}),
		)
		await pool.query("SET time_zone = '-08:00'")
		const db = drizzle(pool, { mode: 'planetscale' })
		execute = (query) => db.execute(query)
	})

	afterAll(async () => {
		await pool?.end()
		if (connection) {
			await connection.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
			await connection.end()
		}
	})

	it('reads the fixture product exactly', async () => {
		expect(
			await readLearningProgress(
				execute,
				learningFixture.productId,
				LEARNING_AS_OF,
			),
		).toEqual(expectedLearningProgress)
	})

	it('returns only count columns from MySQL', async () => {
		const queries: SQL[] = []
		const results: unknown[] = []
		await readLearningProgress(
			async (query) => {
				queries.push(query)
				const result = await execute(query)
				results.push(result)
				return result
			},
			learningFixture.productId,
			LEARNING_AS_OF,
		)
		// Product, roots, three structure levels, roster, progress.
		const [roster, progress] = results.slice(-2) as {
			rows: Record<string, unknown>[]
		}[]
		for (const result of [roster!, progress!]) {
			expect(result.rows).toHaveLength(1)
			expect(Object.keys(result.rows[0]!).join(',')).not.toMatch(
				/userId|email|name/i,
			)
		}
	})

	it('reports an unknown product rather than an empty funnel', async () => {
		await expect(
			readLearningProgress(execute, 'no-such-product', LEARNING_AS_OF),
		).rejects.toBeInstanceOf(LearningProductNotFoundError)
	})
})
