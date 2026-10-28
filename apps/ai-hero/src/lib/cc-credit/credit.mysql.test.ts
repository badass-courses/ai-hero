import mysql, {
	type Pool,
	type PoolConnection,
	type RowDataPacket,
} from 'mysql2/promise'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
vi.mock('@/db/client', () => ({ acquireDatabaseConnection: vi.fn() }))
import { acquireDatabaseConnection } from '@/db/client'
import { signedInOrganizationScopes } from './runtime'
import fc from 'fast-check'
import { mysqlCreditStore } from './store'
import {
	readCreditBalance,
	runCreditCommand,
	type CreditCommand,
} from './service'
import { CreditRefusal } from './domain'

const uri = process.env.AIH_CC_CREDIT_MYSQL_URL
const suite = uri ? describe : describe.skip
function localDatabase(raw: string) {
	const url = new URL(raw)
	if (
		url.protocol !== 'mysql:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
		url.port === '3307' ||
		!/^\/aih_cc_credit_runtime_[a-z0-9_]+$/.test(url.pathname) ||
		url.password !== 'aih_test_password'
	)
		throw new Error('unsafe-cc-credit-runtime-test-db')
	return raw
}
const scope = { stripeCustomerId: 'cus_synthetic' }
const command = (
	invoiceId: string,
	seats: number,
	extra: Partial<CreditCommand> = {},
): CreditCommand => ({
	mode: 'reserve',
	scope,
	seats,
	audit: {
		operatorId: 'synthetic',
		runId: 'synthetic',
		approvalReference: 'synthetic',
	},
	invoice: {
		invoiceId,
		stripeCustomerId: scope.stripeCustomerId,
		status: 'draft',
		currency: 'usd',
		c5Seats: seats,
		c5AmountCents: seats * 100000,
		creditLines: [],
	},
	...extra,
})

suite('CC credit production locking protocol against real MySQL', () => {
	let pool: Pool
	beforeAll(() => {
		pool = mysql.createPool({
			uri: localDatabase(uri!),
			connectionLimit: 12,
			timezone: 'Z',
		})
		vi.mocked(acquireDatabaseConnection).mockImplementation(() =>
			pool.getConnection(),
		)
	})
	afterAll(async () => {
		await pool?.end()
	})
	const store = () => mysqlCreditStore(() => pool.getConnection())
	async function seed(capacity = 4) {
		for (const table of [
			'AI_CcCreditAllocation',
			'AI_CcCreditReservation',
			'AI_Purchase',
			'AI_Coupon',
			'AI_MerchantCharge',
			'AI_MerchantCustomer',
			'AI_MerchantCoupon',
		])
			await pool.query(`DELETE FROM ${table}`)
		await pool.execute(
			"INSERT INTO AI_MerchantCustomer (id, identifier, userId, merchantAccountId, organizationId) VALUES ('mc_synthetic', 'cus_synthetic', 'user_synthetic', 'ma_synthetic', 'org_synthetic')",
		)
		await pool.execute(
			"INSERT INTO AI_MerchantCharge (id, identifier, userId, merchantAccountId, merchantProductId, merchantCustomerId) VALUES ('charge_synthetic', 'ch_synthetic', 'user_synthetic', 'ma_synthetic', 'mp_synthetic', 'mc_synthetic')",
		)
		await pool.execute(
			"INSERT INTO AI_Coupon (id, maxUses) VALUES ('bulk_synthetic', ?)",
			[capacity],
		)
		await pool.execute(
			"INSERT INTO AI_Purchase (id, userId, organizationId, productId, bulkCouponId, totalAmount, status, merchantChargeId) VALUES ('purch_syntheticA', 'user_synthetic', 'org_synthetic', 'product-ma254', 'bulk_synthetic', ?, 'Valid', 'charge_synthetic')",
			[String(capacity * 100)],
		)
	}
	beforeEach(() => seed())
	async function spent() {
		const [rows] = await pool.query<RowDataPacket[]>(
			"SELECT COALESCE(SUM(a.seats),0) AS used FROM AI_CcCreditAllocation a JOIN AI_CcCreditReservation r ON r.invoiceId = a.invoiceId WHERE r.status IN ('reserved','paid')",
		)
		return Number(rows[0]!.used)
	}
	async function attempt(input: CreditCommand, creditStore = store()) {
		try {
			return await runCreditCommand(creditStore, input)
		} catch (e) {
			if (
				e instanceof CreditRefusal ||
				(e &&
					typeof e === 'object' &&
					'code' in e &&
					['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_DUP_ENTRY'].includes(
						String(e.code),
					))
			)
				return null
			throw e
		}
	}

	it('serializes org/customer aliases, preserves the last seat and returns a refusal balance', async () => {
		const results = await Promise.all([
			attempt(command('in_synthetic1', 3)),
			attempt(
				command('in_synthetic2', 3, {
					scope: { ...scope, organizationId: 'org_synthetic' },
				}),
			),
		])
		expect(results.filter(Boolean)).toHaveLength(1)
		expect(await spent()).toBe(3)
		expect(await readCreditBalance(store(), scope)).toMatchObject({
			seats: 1,
			amountCents: 10000,
		})
		await expect(
			runCreditCommand(store(), command('in_synthetic3', 2)),
		).rejects.toMatchObject({
			reason: 'insufficient_credit',
			remaining: { seats: 1, amountCents: 10000 },
		})
	})
	it('allows only a current owner with a current eligible purchase to see organization balances', async () => {
		await pool.query('DELETE FROM AI_OrganizationMembership')
		await pool.query(
			"INSERT INTO AI_OrganizationMembership (id,organizationId,userId,role,invitedById) VALUES ('membership_synthetic','org_synthetic','user_synthetic','owner','user_synthetic')",
		)
		expect(await signedInOrganizationScopes('user_synthetic')).toHaveLength(1)
		await pool.query("UPDATE AI_Purchase SET status='Restricted'")
		expect(await signedInOrganizationScopes('user_synthetic')).toHaveLength(1)
		await pool.query("UPDATE AI_Purchase SET status='Refunded'")
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([])
		await pool.query(
			"UPDATE AI_Purchase SET status='Valid', userId='user_new_owner'",
		)
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([]) // Transferred purchase.
		await pool.query("UPDATE AI_Purchase SET userId='user_synthetic'")
		await pool.query("UPDATE AI_OrganizationMembership SET role='user'")
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([]) // No billing authority.
		await pool.query('DELETE FROM AI_OrganizationMembership')
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([]) // Former member, still has purchase.
	})
	it.each([
		['missing', []],
		[
			'wrong amount',
			[
				{
					description: 'Crash Course team seat credit x 2 (purch_syntheticA)',
					amountCents: -19999,
				},
			],
		],
		[
			'wrong seats',
			[
				{
					description: 'Crash Course team seat credit x 1 (purch_syntheticA)',
					amountCents: -20000,
				},
			],
		],
	] as const)(
		'holds existing reservation inspect with %s invoice lines',
		async (_, lines) => {
			const input = command('in_syntheticInspectHold', 2)
			await runCreditCommand(store(), input)
			await expect(
				runCreditCommand(store(), {
					...input,
					mode: 'inspect',
					invoice: { ...input.invoice, creditLines: [...lines] },
				}),
			).rejects.toBeInstanceOf(CreditRefusal)
			expect(await spent()).toBe(2)
			const correct = [
				{
					description: 'Crash Course team seat credit x 2 (purch_syntheticA)',
					amountCents: -20000,
				},
			]
			expect(
				await runCreditCommand(store(), {
					...input,
					mode: 'inspect',
					invoice: { ...input.invoice, creditLines: correct },
				}),
			).toMatchObject({ idempotent: true })
		},
	)
	it('replays invoices without allocating again and refuses changed seats', async () => {
		const input = command('in_syntheticIdempotent', 2)
		await runCreditCommand(store(), input)
		expect(await runCreditCommand(store(), input)).toMatchObject({
			idempotent: true,
			state: 'reserved',
		})
		expect(await spent()).toBe(2)
		await expect(
			runCreditCommand(store(), { ...input, seats: 1 }),
		).rejects.toMatchObject({
			reason: 'invoice_id_reused_with_changed_request',
		})
	})
	it('settles paid/void from the same lock path and keeps released receipts terminal', async () => {
		const paid = command('in_syntheticPaid', 2)
		await runCreditCommand(store(), paid)
		const creditLines = [
			{
				description: 'Crash Course team seat credit x 2 (purch_syntheticA)',
				amountCents: -20000,
			},
		]
		await runCreditCommand(store(), {
			...paid,
			mode: 'reconcile',
			invoice: { ...paid.invoice, status: 'paid', creditLines },
		})
		const voided = command('in_syntheticVoid', 2)
		await runCreditCommand(store(), voided)
		await runCreditCommand(store(), {
			...voided,
			mode: 'reconcile_preview',
			invoice: { ...voided.invoice, status: 'void' },
		})
		expect(await spent()).toBe(4)
		await runCreditCommand(store(), {
			...voided,
			mode: 'reconcile',
			invoice: { ...voided.invoice, status: 'void' },
		})
		expect(await spent()).toBe(2)
		await expect(runCreditCommand(store(), voided)).rejects.toMatchObject({
			reason: 'invoice_released_or_void_use_new_invoice',
		})
		await expect(
			runCreditCommand(store(), {
				...paid,
				mode: 'reconcile',
				invoice: { ...paid.invoice, status: 'void', creditLines },
			}),
		).rejects.toMatchObject({ reason: 'void_after_payment_hold_for_review' })
	})
	it('keeps previews read-only, holds ambiguous history, and imports idempotently through the same locks', async () => {
		const input = command('in_syntheticHistory', 2)
		await runCreditCommand(store(), { ...input, mode: 'inspect' })
		const historical = {
			...input.invoice,
			status: 'paid',
			creditLines: [
				{
					description: 'Crash Course team seat credit x 2 (purch_syntheticA)',
					amountCents: -20000,
				},
			],
		}
		expect(
			await runCreditCommand(store(), {
				...input,
				mode: 'backfill_preview',
				invoice: historical,
			}),
		).toMatchObject({
			state: 'preview',
			receipt: { status: 'paid', amountCents: 20000 },
		})
		expect(await spent()).toBe(0)
		await expect(
			runCreditCommand(store(), {
				...input,
				mode: 'backfill_preview',
				invoice: {
					...historical,
					creditLines: [
						{ description: 'Crash Course credit', amountCents: -20000 },
					],
				},
			}),
		).rejects.toMatchObject({ reason: 'historical_credit_source_ambiguous' })
		// Only the separately gated import action writes, still through the
		// identical source-lock transaction. This is a local synthetic DB.
		expect(
			await runCreditCommand(store(), {
				...input,
				mode: 'backfill',
				invoice: historical,
			}),
		).toMatchObject({ state: 'paid' })
		expect(await spent()).toBe(2)
		expect(
			await runCreditCommand(store(), {
				...input,
				mode: 'backfill',
				invoice: historical,
			}),
		).toMatchObject({ idempotent: true })
		expect(await spent()).toBe(2)
	})

	it('allocates higher-paid purchases first and applies the paid/non-PPP bulk filters', async () => {
		await pool.execute(
			"INSERT INTO AI_Coupon (id, maxUses) VALUES ('bulk_high', 2)",
		)
		await pool.execute(
			"INSERT INTO AI_Purchase (id, organizationId, productId, bulkCouponId, totalAmount, status, merchantChargeId) VALUES ('purch_syntheticHigh', 'org_synthetic', 'product-ma254', 'bulk_high', '500', 'Restricted', 'charge_synthetic')",
		)
		const result = await runCreditCommand(
			store(),
			command('in_syntheticHigh', 3),
		)
		expect(
			result.receipt.allocations.map((a) => [a.purchaseId, a.seats]),
		).toEqual([
			['purch_syntheticHigh', 2],
			['purch_syntheticA', 1],
		])
		await pool.execute(
			"INSERT INTO AI_MerchantCoupon (id, merchantAccountId, type) VALUES ('promo_ppp', 'ma_synthetic', 'ppp')",
		)
		await pool.execute(
			"INSERT INTO AI_Coupon (id, merchantCouponId) VALUES ('coupon_ppp', 'promo_ppp')",
		)
		await pool.execute(
			"UPDATE AI_Purchase SET couponId = 'coupon_ppp' WHERE id = 'purch_syntheticA'",
		)
		expect(await readCreditBalance(store(), scope)).toMatchObject({ seats: 0 })
		await pool.execute(
			"UPDATE AI_Purchase SET couponId = NULL, totalAmount = '0' WHERE id = 'purch_syntheticA'",
		)
		expect(await readCreditBalance(store(), scope)).toMatchObject({ seats: 0 })
		await pool.execute(
			"UPDATE AI_Purchase SET totalAmount = '400', status = 'Refunded' WHERE id = 'purch_syntheticA'",
		)
		expect(await readCreditBalance(store(), scope)).toMatchObject({ seats: 0 })
	})
	it.each([
		['invoice_customer_mismatch', { stripeCustomerId: 'cus_other' }],
		['unsupported_invoice_currency', { currency: 'eur' }],
		['not_enough_c5_invoice_seats', { c5Seats: 0 }],
		['credit_exceeds_c5_invoice_amount', { c5AmountCents: 100 }],
		['reserve_before_invoice_finalization', { status: 'open' }],
		[
			'invoice_credit_amount_mismatch',
			{
				creditLines: [{ amountCents: -99, description: 'Crash Course credit' }],
			},
		],
	] as const)('refuses %s before any ledger write', async (reason, changed) => {
		const input = command('in_syntheticRefused', 1)
		await expect(
			runCreditCommand(store(), {
				...input,
				invoice: {
					...input.invoice,
					...changed,
					creditLines: 'creditLines' in changed ? [...changed.creditLines] : [],
				},
			}),
		).rejects.toMatchObject({ reason })
		expect(await spent()).toBe(0)
	})
	it('holds duplicate bulk-coupon sources even when the duplicate belongs to a different scope', async () => {
		await pool.execute(
			"INSERT INTO AI_Purchase (id, organizationId, productId, bulkCouponId, totalAmount, status) VALUES ('purch_duplicate', 'org_other', 'product-ma254', 'bulk_synthetic', '400', 'Valid')",
		)
		await expect(
			runCreditCommand(store(), command('in_syntheticDuplicate', 1)),
		).rejects.toMatchObject({
			reason: 'shared_bulk_coupon_source_hold_for_review',
		})
		expect(await spent()).toBe(0)
	})
	it('rolls back the invoice receipt if any allocation insert fails', async () => {
		const broken = mysqlCreditStore(async () => {
			const connection = await pool.getConnection()
			return new Proxy(connection, {
				get(target, prop) {
					if (prop === 'execute')
						return async (sql: string, params: (string | number | null)[]) => {
							if (sql.includes('INSERT INTO AI_CcCreditAllocation'))
								throw new Error('synthetic allocation failure')
							return target.execute(sql, params)
						}
					const value = Reflect.get(target, prop)
					return typeof value === 'function' ? value.bind(target) : value
				},
			}) as PoolConnection
		})
		await expect(
			runCreditCommand(broken, command('in_syntheticRollback', 1)),
		).rejects.toThrow('synthetic allocation failure')
		const [rows] = await pool.query<RowDataPacket[]>(
			'SELECT * FROM AI_CcCreditReservation',
		)
		expect(rows).toEqual([])
		expect(await spent()).toBe(0)
	})

	/** Test-only planted mutant: remove locking reads from the production SQL
	 * adapter, then force both writers past their consumed-seat read before
	 * either writes. No production path has a switch to disable locking.
	 */
	function unlockedStore() {
		let arrivals = 0
		let release!: () => void
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		return mysqlCreditStore(async () => {
			const connection = await pool.getConnection()
			return new Proxy(connection, {
				get(target, prop) {
					if (prop === 'execute')
						return async (sql: string, params: (string | number | null)[]) => {
							const result = await target.execute(
								sql.replaceAll(' FOR UPDATE', ''),
								params,
							)
							if (sql.includes('SELECT a.seats, r.status')) {
								if (++arrivals === 2) release()
								await barrier
							}
							return result
						}
					const value = Reflect.get(target, prop)
					return typeof value === 'function' ? value.bind(target) : value
				},
			}) as PoolConnection
		})
	}
	function scheduledStore(scheduler: fc.Scheduler) {
		return mysqlCreditStore(async () => {
			const connection = await pool.getConnection()
			return new Proxy(connection, {
				get(target, prop) {
					if (prop === 'execute')
						return async (sql: string, params: (string | number | null)[]) => {
							// Schedule BEFORE issuing SQL, never schedule an unresolved lock
							// wait ahead of the query that would release it.
							await scheduler.schedule(Promise.resolve(), sql.slice(0, 48))
							return target.execute(sql, params)
						}
					const value = Reflect.get(target, prop)
					return typeof value === 'function' ? value.bind(target) : value
				},
			}) as PoolConnection
		})
	}
	it('locking concurrency property: consumption never exceeds purchased seats', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.integer({ min: 1, max: 15 }),
				fc.array(fc.integer({ min: 1, max: 12 }), {
					minLength: 2,
					maxLength: 6,
				}),
				async (scheduler, capacity, requests) => {
					await seed(capacity)
					const selected =
						process.env.AIH_CC_CREDIT_PLANT_UNLOCKED === '1'
							? unlockedStore()
							: scheduledStore(scheduler)
					// Mutant mode is a deliberate failing proof command; two full-pool
					// requests and a read barrier expose the unlocked read/write race.
					const batch =
						process.env.AIH_CC_CREDIT_PLANT_UNLOCKED === '1'
							? [capacity, capacity]
							: requests
					await scheduler.waitFor(
						Promise.all(
							batch.map((seats, i) =>
								attempt(
									command(`in_syntheticProp${i}`, seats, {
										scope:
											i % 2
												? { ...scope, organizationId: 'org_synthetic' }
												: scope,
									}),
									selected,
								),
							),
						),
					)
					expect(await spent()).toBeLessThanOrEqual(capacity)
				},
			),
			{ numRuns: 40, seed: 20261028, endOnFailure: true },
		)
	}, 30000)
	it('planted unlocked writer fails the identical capacity property (negative control)', async () => {
		const result = await fc.check(
			fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (capacity) => {
				await seed(capacity)
				const mutant = unlockedStore()
				await Promise.all([
					attempt(command('in_syntheticMutant1', capacity), mutant),
					attempt(command('in_syntheticMutant2', capacity), mutant),
				])
				return (await spent()) <= capacity
			}),
			{ numRuns: 1, seed: 20261028, endOnFailure: true },
		)
		expect(result.failed).toBe(true)
		expect(result.counterexample).not.toBeNull()
		console.info(
			`Planted unlocked SQL property FAILED as required: seed=${result.seed}, capacity=${result.counterexample?.[0]}`,
		)
	}, 10000)
})
