import 'server-only'
import { acquireDatabaseConnection } from '@/db/client'
import type { RowDataPacket } from 'mysql2/promise'
import { C5_PRODUCT, CreditRefusal } from './domain'
import { mysqlCreditStore } from './store'

/** Off until historical invoices are reviewed/backfilled. Previews share prod DB. */
export function creditEnabled() {
	return (
		process.env.AIH_CC_CREDIT_ENABLED === '1' &&
		process.env.VERCEL_ENV !== 'preview'
	)
}
/** Separate, temporary permission for owner-approved historical imports only. */
export function creditImportEnabled() {
	return (
		process.env.AIH_CC_CREDIT_IMPORT_ENABLED === '1' &&
		process.env.VERCEL_ENV !== 'preview'
	)
}
export function assertCreditWritesAllowed(stripeKey: string) {
	if (process.env.VERCEL_ENV === 'preview')
		throw new CreditRefusal('credit_writes_refused_on_preview')
	if (process.env.VERCEL_ENV === 'production') return
	let loopback = false
	try {
		loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(
			new URL(process.env.DATABASE_URL ?? '').hostname,
		)
	} catch {
		/* refuse */
	}
	if (!/^(sk|rk)_test_/.test(stripeKey) || !loopback)
		throw new CreditRefusal(
			'credit_writes_require_production_or_local_test_database',
		)
}
export const creditStore = mysqlCreditStore(acquireDatabaseConnection)
export async function c5StripeProducts() {
	const connection = await acquireDatabaseConnection()
	try {
		const [rows] = await connection.execute<RowDataPacket[]>(
			'SELECT identifier FROM AI_MerchantProduct WHERE productId = ?',
			[C5_PRODUCT],
		)
		if (!rows.length)
			throw new CreditRefusal('c5_stripe_product_mapping_missing')
		return new Set(rows.map((row) => String(row.identifier)))
	} finally {
		connection.release()
	}
}
export async function signedInOrganizationScopes(userId: string) {
	const connection = await acquireDatabaseConnection()
	try {
		const [rows] = await connection.execute<RowDataPacket[]>(
			`SELECT DISTINCT m.organizationId
			 FROM AI_OrganizationMembership m
			 JOIN AI_Purchase p ON BINARY p.organizationId = BINARY m.organizationId AND BINARY p.userId = BINARY m.userId
			 WHERE BINARY m.userId = ? AND m.organizationId IS NOT NULL
			 AND m.role = 'owner' AND p.status IN ('Valid', 'Restricted') AND p.productId = ?`,
			[userId, 'product-ma254'],
		)
		return rows.map((row) => ({
			organizationId: String(row.organizationId),
			stripeCustomerId: '',
		}))
	} finally {
		connection.release()
	}
}
