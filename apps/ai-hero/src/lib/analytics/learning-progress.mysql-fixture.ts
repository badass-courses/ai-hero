import mysql, { type Connection, type Pool } from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import type { SQL } from 'drizzle-orm'

import { preserveQueryResultShape } from '@/db/mysql-query-client'

/** Columns the queries read, with the production key names. */
const ddl = [
	`CREATE TABLE AI_Product (id varchar(191) NOT NULL PRIMARY KEY, name varchar(191) NOT NULL, type varchar(191))`,
	`CREATE TABLE AI_ContentResource (id varchar(255) NOT NULL PRIMARY KEY, type varchar(255) NOT NULL, fields json, deletedAt timestamp(3) NULL)`,
	`CREATE TABLE AI_ContentResourceProduct (productId varchar(255) NOT NULL, resourceId varchar(255) NOT NULL, position double NOT NULL DEFAULT 0, deletedAt timestamp(3) NULL, PRIMARY KEY (productId, resourceId), KEY resourceId_idx (resourceId))`,
	`CREATE TABLE AI_ContentResourceResource (resourceOfId varchar(255) NOT NULL, resourceId varchar(255) NOT NULL, position double NOT NULL DEFAULT 0, deletedAt timestamp(3) NULL, PRIMARY KEY (resourceOfId, resourceId), KEY contentResourceId_idx (resourceOfId), KEY resourceId_idx (resourceId))`,
	`CREATE TABLE AI_User (id varchar(255) NOT NULL PRIMARY KEY, name varchar(255), email varchar(255) NOT NULL, emailVerified timestamp(3) NULL)`,
	`CREATE TABLE AI_Account (provider varchar(255) NOT NULL, providerAccountId varchar(255) NOT NULL, userId varchar(255) NOT NULL, PRIMARY KEY (provider, providerAccountId), KEY userId_idx (userId))`,
	`CREATE TABLE AI_Session (sessionToken varchar(255) NOT NULL PRIMARY KEY, userId varchar(255) NOT NULL, expires timestamp NOT NULL, KEY userId_idx (userId))`,
	`CREATE TABLE AI_Organization (id varchar(255) NOT NULL PRIMARY KEY, name varchar(255))`,
	`CREATE TABLE AI_Coupon (id varchar(191) NOT NULL PRIMARY KEY, maxUses int NOT NULL DEFAULT -1, usedCount int NOT NULL DEFAULT 0)`,
	`CREATE TABLE AI_Purchase (id varchar(191) NOT NULL PRIMARY KEY, userId varchar(191), organizationId varchar(191), createdAt timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), productId varchar(191) NOT NULL, status varchar(191) NOT NULL DEFAULT 'Valid', totalAmount decimal(65,30) NOT NULL, bulkCouponId varchar(191), redeemedBulkCouponId varchar(191), KEY idx_Purchase_on_userId_status_productId (userId, status, productId), KEY idx_Purchase_on_productId (productId), KEY idx_Purchase_on_bulkCouponId (bulkCouponId), KEY idx_Purchase_on_redeemedBulkCouponId (redeemedBulkCouponId))`,
	`CREATE TABLE AI_PurchaseUserTransfer (id varchar(191) NOT NULL PRIMARY KEY, transferState enum('AVAILABLE','INITIATED','VERIFIED','CANCELED','EXPIRED','CONFIRMED','COMPLETED') NOT NULL DEFAULT 'AVAILABLE', purchaseId varchar(191) NOT NULL, sourceUserId varchar(191) NOT NULL, targetUserId varchar(191), KEY idx_PurchaseUserTransfer_on_purchaseId (purchaseId))`,
	`CREATE TABLE AI_ResourceProgress (userId varchar(255) NOT NULL, resourceId varchar(255) NOT NULL, completedAt datetime(3), updatedAt datetime(3), createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (userId, resourceId), KEY contentResourceId_idx (resourceId), KEY resourceId_idx (userId))`,
]

type Row = { readonly [key: string]: unknown }
/** Optional row fields default in the inserts below. */
export type LearningDatabaseFixture = {
	productId: string
	product: { name: string; type: string }
	resources: readonly { id: string; type: string; fields: object }[]
	/** [parent, child, position, deleted] */
	links: readonly (readonly [string, string, number, boolean])[]
	users: readonly (Row & { id: string })[]
	organizations?: readonly { id: string; name: string }[]
	coupons: readonly { id: string; maxUses: number; usedCount: number }[]
	purchases: readonly (Row & { id: string; userId: string; status: string })[]
	transfers: readonly Row[]
	/** [userId, lessonId, createdAt, completedAt] */
	progress: readonly (readonly [string, string, string, string | null])[]
}

/**
 * Own disposable database only. Never touches the URL's database or existing
 * tables. Returns a one-connection executor pinned to a -08:00 session, so
 * DATETIME progress columns must not drift with the zone.
 */
export async function createLearningDatabase(
	url: string,
	fixture: LearningDatabaseFixture,
	label: string,
) {
	const target = new URL(url)
	if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
		throw new Error('MySQL fixtures must be local')
	const prefix = target.pathname.slice(1).replace(/_app$/, '') || 'aih'
	if (!/^[a-zA-Z0-9_]+$/.test(prefix) || !/^[a-z]+$/.test(label))
		throw new Error('Invalid fixture database prefix')
	const databaseName = `${prefix}_${label}_${process.pid}_${Date.now()}`
	const connection: Connection = await mysql.createConnection({
		uri: url,
		timezone: 'Z',
	})
	await connection.query(`CREATE DATABASE \`${databaseName}\``)
	await connection.query(`USE \`${databaseName}\``)
	await connection.query("SET time_zone = '-08:00'")
	for (const statement of ddl) await connection.query(statement)

	const f = fixture
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
		await connection.query(
			'INSERT INTO AI_User (id, name, email, emailVerified) VALUES (?, ?, ?, ?)',
			[
				user.id,
				user.name ?? null,
				user.email ?? `${user.id}@example.test`,
				user.emailVerified,
			],
		)
		if (user.account)
			await connection.query('INSERT INTO AI_Account VALUES (?, ?, ?)', [
				'github',
				`gh-${user.id}`,
				user.id,
			])
		if (user.session)
			await connection.query(
				'INSERT INTO AI_Session VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)',
				[`session-${user.id}`, user.id],
			)
	}
	for (const organization of f.organizations ?? [])
		await connection.query('INSERT INTO AI_Organization VALUES (?, ?)', [
			organization.id,
			organization.name,
		])
	for (const coupon of f.coupons)
		await connection.query('INSERT INTO AI_Coupon VALUES (?, ?, ?)', [
			coupon.id,
			coupon.maxUses,
			coupon.usedCount,
		])
	for (const purchase of f.purchases)
		await connection.query(
			`INSERT INTO AI_Purchase (id, userId, organizationId, createdAt, productId, status, totalAmount, bulkCouponId, redeemedBulkCouponId)
			VALUES (?, ?, ?, COALESCE(CONVERT_TZ(?, '+00:00', @@session.time_zone), CURRENT_TIMESTAMP(3)), ?, ?, ?, ?, ?)`,
			[
				purchase.id,
				purchase.userId,
				purchase.organizationId ?? null,
				purchase.createdAt ?? null,
				purchase.productId ?? f.productId,
				purchase.status,
				purchase.totalAmount ?? 199,
				purchase.bulkCouponId ?? null,
				purchase.redeemedBulkCouponId ?? null,
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
	const pool: Pool = preserveQueryResultShape(
		mysql.createPool({
			uri: target.toString(),
			connectionLimit: 1,
			timezone: 'Z',
		}),
	)
	await pool.query("SET time_zone = '-08:00'")
	const db = drizzle(pool, { mode: 'planetscale' })
	return {
		execute: (query: SQL): Promise<unknown> => db.execute(query),
		async close() {
			await pool.end()
			await connection.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
			await connection.end()
		},
	}
}
