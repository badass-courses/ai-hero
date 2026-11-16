import * as schema from '@/db/schema'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql, { type Pool } from 'mysql2/promise'
import type Stripe from 'stripe'
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

import { linkEarlyAccessPayment } from './early-access-payment'
import {
	createEarlyAccessPurchase,
	type EarlyAccessDatabase,
} from './early-access-purchase'

const uri = process.env.AIH_EARLY_ACCESS_MYSQL_URL
const suite = uri ? describe : describe.skip

const TABLES = [
	schema.users,
	schema.products,
	schema.merchantAccount,
	schema.merchantProduct,
	schema.merchantCustomer,
	schema.merchantSession,
	schema.merchantCharge,
	schema.purchases,
	schema.coupon,
	schema.purchaseUserTransfer,
]

// The workflow applies the generated app schema to a disposable loopback
// database first (scripts/test-mysql-schema.mjs), as the coupon mint suite does.

const ACCOUNT = 'acct-fixture'
const STRIPE_PRODUCT = 'prod_fixture'
const STRIPE_CUSTOMER = 'cus_fixture'
const attendee = { id: 'user-attendee', email: 'attendee@example.test' }
const payer = { id: 'user-payer', email: 'billing@example.test' }

function invoice(id: string, paid = false): Stripe.Invoice {
	return {
		id,
		status: paid ? 'paid' : 'open',
		amount_paid: paid ? 90650 : 0,
		created: 1_763_000_000,
		status_transitions: { paid_at: paid ? 1_763_100_000 : null },
		charge: paid ? `ch_${id}` : null,
		customer: { id: STRIPE_CUSTOMER, email: attendee.email, deleted: false },
		customer_email: payer.email,
		subscription: null,
		metadata: { accessProvisioning: 'manual_early_access_granted' },
		lines: {
			has_more: false,
			data: [
				{
					amount: 129500,
					quantity: 1,
					price: { product: STRIPE_PRODUCT },
				},
			],
		},
	} as unknown as Stripe.Invoice
}

const findUser = async (email: string) => {
	expect(email).toBe(attendee.email)
	return { user: attendee as never }
}

suite('early access when the payer is not the attendee', () => {
	let pool: Pool
	let database: EarlyAccessDatabase

	beforeAll(async () => {
		const url = new URL(uri!)
		if (
			!['127.0.0.1', 'localhost'].includes(url.hostname) ||
			url.pathname !== '/early_access_test'
		)
			throw new Error('Refusing a non-loopback or non-test database')
		pool = mysql.createPool({ uri: uri!, connectionLimit: 4 })
		database = drizzle(pool, {
			schema,
			mode: 'default',
		}) as unknown as EarlyAccessDatabase
		state.database = database
	})

	beforeEach(async () => {
		for (const table of TABLES)
			await pool.query(`DELETE FROM \`${getTableConfig(table).name}\``)
		await database.insert(schema.users).values([attendee, payer] as never)
		await database
			.insert(schema.products)
			.values({ id: 'product-fixture', name: 'Fixture', status: 1 } as never)
		await database.insert(schema.merchantAccount).values({
			id: ACCOUNT,
			label: 'stripe',
			identifier: 'acct',
			status: 1,
		} as never)
		await database.insert(schema.merchantProduct).values({
			id: 'mproduct-fixture',
			identifier: STRIPE_PRODUCT,
			productId: 'product-fixture',
			merchantAccountId: ACCOUNT,
			status: 1,
		} as never)
	})

	afterAll(async () => {
		await pool?.end()
	})

	it('bills the owner of an existing Stripe customer and links payment', async () => {
		await database.insert(schema.merchantCustomer).values({
			id: 'mcustomer-payer',
			identifier: STRIPE_CUSTOMER,
			userId: payer.id,
			merchantAccountId: ACCOUNT,
			status: 1,
		} as never)

		const purchase = await createEarlyAccessPurchase(
			database as never,
			invoice('in_split'),
			'2026-11-10T12:01:36.000Z',
			findUser,
		)
		const [holder] = await pool.query<any[]>(
			'SELECT userId FROM AI_Purchase WHERE id = ?',
			[purchase.id],
		)
		expect(holder).toEqual([{ userId: attendee.id }])
		expect(purchase.fields?.earlyAccessBillingUserId).toBe(payer.id)

		const linked = await linkEarlyAccessPayment(
			database,
			invoice('in_split', true),
			purchase.id,
		)
		const [charge] = await pool.query<any[]>(
			'SELECT userId, merchantCustomerId FROM AI_MerchantCharge WHERE identifier = ?',
			['ch_in_split'],
		)
		expect(linked.purchaseId).toBe(purchase.id)
		expect(charge).toEqual([
			{ userId: payer.id, merchantCustomerId: 'mcustomer-payer' },
		])
		const [customers] = await pool.query<any[]>(
			'SELECT COUNT(*) n FROM AI_MerchantCustomer',
		)
		expect(Number(customers[0].n)).toBe(1)
	})

	it('creates the customer row for the attendee when none exists', async () => {
		const purchase = await createEarlyAccessPurchase(
			database as never,
			invoice('in_single'),
			'2026-11-10T12:01:36.000Z',
			findUser,
		)
		expect(purchase.fields?.earlyAccessBillingUserId).toBe(attendee.id)
		await linkEarlyAccessPayment(
			database,
			invoice('in_single', true),
			purchase.id,
		)
		const [charge] = await pool.query<any[]>(
			'SELECT userId FROM AI_MerchantCharge WHERE identifier = ?',
			['ch_in_single'],
		)
		expect(charge).toEqual([{ userId: attendee.id }])
	})
})
