import 'server-only'
import { acquireDatabaseConnection } from '@/db/client'
import type { RowDataPacket } from 'mysql2/promise'
import Stripe from 'stripe'
import { C5_PRODUCT, CreditRefusal } from './domain'
import { mysqlCreditStore } from './store'
import { readSourcePayments } from './stripe'

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
let stripe: Stripe | null = null
export const creditStore = mysqlCreditStore(
	acquireDatabaseConnection,
	async (rows) => {
		// Missing Stripe credentials are unavailable evidence, never zero credit.
		const key = process.env.STRIPE_SECRET_TOKEN
		if (!key) throw new Error('stripe_unavailable')
		stripe ??= new Stripe(key, {
			apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
		})
		return readSourcePayments(stripe, rows)
	},
)
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
/** Owners live in AI_OrganizationMembershipRole + AI_Role, like the team
 * manager directory. AI_OrganizationMembership.role is always 'user' in prod. */
export async function signedInOrganizationScopes(userId: string) {
	const connection = await acquireDatabaseConnection()
	try {
		const [rows] = await connection.execute<RowDataPacket[]>(
			`SELECT DISTINCT m.organizationId
			 FROM AI_OrganizationMembership m
			 JOIN AI_OrganizationMembershipRole mr ON mr.organizationMembershipId = m.id
			 JOIN AI_Role r ON r.id = mr.roleId
			 JOIN AI_Purchase p ON BINARY p.organizationId = BINARY m.organizationId AND BINARY p.userId = BINARY m.userId
			 WHERE BINARY m.userId = ? AND m.organizationId IS NOT NULL
			 AND mr.active = 1 AND mr.deletedAt IS NULL
			 AND r.active = 1 AND r.deletedAt IS NULL AND r.name = 'owner'
			 AND p.status IN ('Valid', 'Restricted') AND p.productId = ?`,
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
