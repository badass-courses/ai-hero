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
import { customerBoughtTeamSeats, mysqlCreditStore } from './store'
import {
	readCreditBalance,
	runCreditCommand,
	type CreditCommand,
} from './service'
import {
	CreditRefusal,
	type SourcePayment,
	type SourcePaymentReader,
	type SourcePaymentRow,
} from './domain'

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
const PURCHASE_A = 'purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f'
/** Synthetic Stripe charge cents and checkout quantity, keyed by purchase. */
const stripeFacts = new Map<string, SourcePayment>()
const paymentReads: SourcePaymentRow[][] = []
let probeLocks: (() => Promise<number>) | null = null
const lockCounts: number[] = []
const payments: SourcePaymentReader = async (rows) => {
	paymentReads.push(rows)
	if (probeLocks) lockCounts.push(await probeLocks())
	return new Map(
		rows.flatMap((row) => {
			const fact = stripeFacts.get(row.purchaseId)
			return fact ? [[row.purchaseId, fact] as const] : []
		}),
	)
}
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
	const store = () => mysqlCreditStore(() => pool.getConnection(), payments)
	async function seed(capacity = 4) {
		stripeFacts.clear()
		paymentReads.length = 0
		for (const table of [
			'AI_CcCreditAllocation',
			'AI_CcCreditReservation',
			'AI_Purchase',
			'AI_Coupon',
			'AI_MerchantCharge',
			'AI_MerchantCustomer',
			'AI_MerchantCoupon',
			'AI_MerchantSession',
		])
			await pool.query(`DELETE FROM ${table}`)
		stripeFacts.set(PURCHASE_A, { chargeCents: capacity * 10000, seats: null })
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
			"INSERT INTO AI_Purchase (id, userId, organizationId, productId, bulkCouponId, totalAmount, status, merchantChargeId) VALUES ('purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f', 'user_synthetic', 'org_synthetic', 'product-ma254', 'bulk_synthetic', ?, 'Valid', 'charge_synthetic')",
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
		for (const table of [
			'AI_OrganizationMembershipRole',
			'AI_Role',
			'AI_OrganizationMembership',
		])
			await pool.query(`DELETE FROM ${table}`)
		// Production shape: membership.role is always 'user'; ownership is a role row.
		await pool.query(
			"INSERT INTO AI_OrganizationMembership (id,organizationId,userId,role,invitedById) VALUES ('membership_synthetic','org_synthetic','user_synthetic','user','user_synthetic')",
		)
		await pool.query(
			"INSERT INTO AI_Role (id,name) VALUES ('role_owner','owner'),('role_learner','learner')",
		)
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([])
		await pool.query(
			"INSERT INTO AI_OrganizationMembershipRole (organizationMembershipId,roleId,organizationId) VALUES ('membership_synthetic','role_owner','org_synthetic')",
		)
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([
			{ organizationId: 'org_synthetic', stripeCustomerId: '' },
		])
		for (const [revoke, restore] of [
			['UPDATE AI_OrganizationMembershipRole SET active=0', 'active=1'],
			[
				'UPDATE AI_OrganizationMembershipRole SET deletedAt=NOW(3)',
				'deletedAt=NULL',
			],
			['UPDATE AI_Role SET active=0', 'active=1'],
			['UPDATE AI_Role SET deletedAt=NOW(3)', 'deletedAt=NULL'],
			[
				"UPDATE AI_OrganizationMembershipRole SET roleId='role_learner'",
				"roleId='role_owner'",
			],
		] as const) {
			await pool.query(revoke)
			expect(await signedInOrganizationScopes('user_synthetic')).toEqual([])
			await pool.query(revoke.replace(/SET .*/, `SET ${restore}`))
			expect(await signedInOrganizationScopes('user_synthetic')).toHaveLength(1)
		}
		await pool.query("UPDATE AI_Purchase SET status='Restricted'")
		expect(await signedInOrganizationScopes('user_synthetic')).toHaveLength(1)
		await pool.query("UPDATE AI_Purchase SET status='Refunded'")
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([])
		await pool.query(
			"UPDATE AI_Purchase SET status='Valid', userId='user_new_owner'",
		)
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([]) // Transferred purchase.
		await pool.query("UPDATE AI_Purchase SET userId='user_synthetic'")
		await pool.query('DELETE FROM AI_OrganizationMembershipRole')
		await pool.query("UPDATE AI_OrganizationMembership SET role='owner'")
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([]) // The legacy column grants nothing.
		await pool.query('DELETE FROM AI_OrganizationMembership')
		expect(await signedInOrganizationScopes('user_synthetic')).toEqual([]) // Former member, still has purchase.
	})
	it.each([
		['missing', []],
		[
			'wrong amount',
			[
				{
					description: 'Crash Course team seat credit x 2 (purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f)',
					amountCents: -19999,
				},
			],
		],
		[
			'wrong seats',
			[
				{
					description: 'Crash Course team seat credit x 1 (purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f)',
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
					description: 'Crash Course team seat credit x 2 (purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f)',
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
				description: 'Crash Course team seat credit x 2 (purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f)',
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
					description: 'Crash Course team seat credit x 2 (purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f)',
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
		stripeFacts.set('purch_syntheticHigh', { chargeCents: 50000, seats: null })
		const result = await runCreditCommand(
			store(),
			command('in_syntheticHigh', 3),
		)
		expect(
			result.receipt.allocations.map((a) => [a.purchaseId, a.seats]),
		).toEqual([
			['purch_syntheticHigh', 2],
			['purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f', 1],
		])
		await pool.execute(
			"INSERT INTO AI_MerchantCoupon (id, merchantAccountId, type) VALUES ('promo_ppp', 'ma_synthetic', 'ppp')",
		)
		await pool.execute(
			"INSERT INTO AI_Coupon (id, merchantCouponId) VALUES ('coupon_ppp', 'promo_ppp')",
		)
		await pool.execute(
			"UPDATE AI_Purchase SET couponId = 'coupon_ppp' WHERE id = 'purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f'",
		)
		expect(await readCreditBalance(store(), scope)).toMatchObject({ seats: 0 })
		await pool.execute(
			"UPDATE AI_Purchase SET couponId = NULL, totalAmount = '0' WHERE id = 'purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f'",
		)
		expect(await readCreditBalance(store(), scope)).toMatchObject({ seats: 0 })
		await pool.execute(
			"UPDATE AI_Purchase SET totalAmount = '400', status = 'Refunded' WHERE id = 'purch_6f1c2a7e-0b3d-4c5a-9e8f-1a2b3c4d5e6f'",
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
	// First and last uuid segments: unique even when two ids share a prefix.
	const fixtureKey = (id: string) => `${id.slice(6, 14)}${id.slice(-12)}`
	/** Realistic team purchase: its own charge and checkout session, a purch_<uuid>
	 * id, the DB total as stored (maybe rounded) and the Stripe facts as paid. */
	async function teamPurchase(input: {
		id: string
		coupon: string
		recorded: string
		chargeCents: number
		seats: number | null
		organizationId?: string | null
		merchantCustomerId?: string
	}) {
		const key = fixtureKey(input.id)
		await pool.execute(
			"INSERT INTO AI_MerchantCharge (id, identifier, userId, merchantAccountId, merchantProductId, merchantCustomerId) VALUES (?, ?, 'user_synthetic', 'ma_synthetic', 'mp_synthetic', ?)",
			[
				`mc_charge_${key}`,
				`ch_${key}`,
				input.merchantCustomerId ?? 'mc_synthetic',
			],
		)
		await pool.execute(
			"INSERT INTO AI_MerchantSession (id, identifier, merchantAccountId) VALUES (?, ?, 'ma_synthetic')",
			[`ms_${key}`, `cs_${key}`],
		)
		await pool.execute(
			"INSERT INTO AI_Purchase (id, userId, organizationId, productId, bulkCouponId, totalAmount, status, merchantChargeId, merchantSessionId) VALUES (?, 'user_synthetic', ?, 'product-ma254', ?, ?, 'Valid', ?, ?)",
			[
				input.id,
				input.organizationId === undefined
					? 'org_synthetic'
					: input.organizationId,
				input.coupon,
				input.recorded,
				`mc_charge_${key}`,
				`ms_${key}`,
			],
		)
		stripeFacts.set(input.id, {
			chargeCents: input.chargeCents,
			seats: input.seats,
		})
	}
	const ORIGINAL = 'purch_0b6d1f2e-3c4a-4b5c-8d6e-7f8091a2b3c4'
	const ADDON = 'purch_9c8b7a6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
	const THREE_SEATS = 'purch_5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d'
	async function sharedCouponTeam(addonOrganizationId?: string | null) {
		await pool.query('DELETE FROM AI_Purchase')
		stripeFacts.clear()
		await pool.execute(
			"INSERT INTO AI_Coupon (id, maxUses) VALUES ('bulk_team', 12)",
		)
		// 2 seats at $199, then 10 add-on seats at $224.25 paid ($2,242.50),
		// stored rounded as $2,243. Both share the one 12-seat bulk coupon.
		await teamPurchase({
			id: ORIGINAL,
			coupon: 'bulk_team',
			recorded: '398.000000000000000000000000000000',
			chargeCents: 39800,
			seats: 2,
		})
		await teamPurchase({
			id: ADDON,
			coupon: 'bulk_team',
			recorded: '2243.000000000000000000000000000000',
			chargeCents: 224250,
			seats: 10,
			organizationId: addonOrganizationId,
		})
	}
	const historicalInvoice = (
		invoiceId: string,
		seats: number,
		status: string,
		creditLines: { description: string; amountCents: number }[],
	) => {
		const input = command(invoiceId, seats, { mode: 'backfill_preview' })
		return { ...input, invoice: { ...input.invoice, status, creditLines } }
	}

	const orgScope = { stripeCustomerId: '', organizationId: 'org_synthetic' }
	it('counts an add-seat purchase with no org toward its team org, only on clear evidence', async () => {
		// Production Team A: the add-on checkout recorded no org.
		await sharedCouponTeam(null)
		const team = { seats: 12, amountCents: 39800 + 224250 }
		expect(await readCreditBalance(store(), orgScope)).toMatchObject(team)
		expect(await readCreditBalance(store(), scope)).toMatchObject(team)
		// Same evidence from the bulk coupon's own org, with no org purchase at all.
		await pool.query("UPDATE AI_Coupon SET organizationId = 'org_synthetic'")
		await pool.query('UPDATE AI_Purchase SET organizationId = NULL')
		expect(await readCreditBalance(store(), orgScope)).toMatchObject(team)
		// Two orgs claim the coupon: hold, don't guess.
		await pool.query("UPDATE AI_Coupon SET organizationId = 'org_other'")
		await pool.execute(
			"UPDATE AI_Purchase SET organizationId = 'org_synthetic' WHERE id = ?",
			[ORIGINAL],
		)
		await expect(readCreditBalance(store(), orgScope)).rejects.toMatchObject({
			reason: 'bulk_coupon_organization_ambiguous_hold_for_review',
		})
		// Another customer's purchase on the coupon is not the team's evidence.
		await pool.query('UPDATE AI_Coupon SET organizationId = NULL')
		await pool.execute(
			"INSERT INTO AI_MerchantCustomer (id, identifier, userId, merchantAccountId) VALUES ('mc_stranger', 'cus_stranger', 'user_stranger', 'ma_synthetic')",
		)
		await pool.execute(
			"UPDATE AI_MerchantCharge SET merchantCustomerId = 'mc_stranger' WHERE id = ?",
			[`mc_charge_${fixtureKey(ADDON)}`],
		)
		expect(await readCreditBalance(store(), orgScope)).toMatchObject({
			seats: 2,
			amountCents: 39800,
		})
	})
	it('accepts a line naming a unique purch_ prefix at a segment boundary, nothing looser', async () => {
		await sharedCouponTeam(null)
		const prefix = ADDON.slice(0, 14)
		const line = (named: string, amountCents = -44860) =>
			historicalInvoice('in_syntheticPrefix', 2, 'paid', [
				{
					description: `Crash Course team seat credit x 2 (${named}, $224.30 per seat)`,
					amountCents,
				},
			])
		const sources = [{ purchaseId: ADDON, seats: 2, perSeatCents: 22430 }]
		expect(
			await runCreditCommand(store(), { ...line(prefix), sources }),
		).toMatchObject({
			state: 'preview',
			receipt: {
				status: 'paid',
				amountCents: 44860,
				allocations: [{ purchaseId: ADDON, seats: 2, perSeatCents: 22430 }],
			},
		})
		// Without a source, the prefix resolves but $448.60 isn't whole seats.
		await expect(runCreditCommand(store(), line(prefix))).rejects.toMatchObject(
			{ reason: 'invalid_historical_credit_seats' },
		)
		expect(
			await runCreditCommand(store(), line(prefix, -44850)),
		).toMatchObject({
			receipt: { allocations: [{ purchaseId: ADDON, perSeatCents: 22425 }] },
		})
		for (const named of [ORIGINAL.slice(0, 14), ADDON.slice(0, 12)])
			await expect(
				runCreditCommand(store(), { ...line(named), sources }),
			).rejects.toMatchObject({
				reason: 'explicit_source_contradicts_invoice_line',
			})
		// A second eligible source sharing the first segment makes it ambiguous.
		await pool.execute(
			"INSERT INTO AI_Coupon (id, maxUses) VALUES ('bulk_twin', 1)",
		)
		await teamPurchase({
			id: `${prefix}-0000-4000-8000-000000000000`,
			coupon: 'bulk_twin',
			recorded: '224.25',
			chargeCents: 22425,
			seats: null,
		})
		await expect(
			runCreditCommand(store(), { ...line(prefix), sources }),
		).rejects.toMatchObject({
			reason: 'explicit_source_contradicts_invoice_line',
		})
		await expect(
			runCreditCommand(store(), line(prefix, -44850)),
		).rejects.toMatchObject({ reason: 'historical_credit_source_ineligible' })
		expect(await spent()).toBe(0)
	})
	it('tells a team buyer from an individual buyer with a plain SELECT', async () => {
		await pool.execute(
			"INSERT INTO AI_MerchantCustomer (id, identifier, userId, merchantAccountId) VALUES ('mc_solo', 'cus_solo', 'user_solo', 'ma_synthetic')",
		)
		await pool.execute(
			"INSERT INTO AI_MerchantCharge (id, identifier, userId, merchantAccountId, merchantProductId, merchantCustomerId) VALUES ('charge_solo', 'ch_solo', 'user_solo', 'ma_synthetic', 'mp_synthetic', 'mc_solo')",
		)
		await pool.execute(
			"INSERT INTO AI_Purchase (id, userId, productId, totalAmount, status, merchantChargeId) VALUES ('purch_1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a', 'user_solo', 'product-ma254', '199', 'Valid', 'charge_solo')",
		)
		expect(await customerBoughtTeamSeats(pool, 'cus_synthetic')).toBe(true)
		expect(await customerBoughtTeamSeats(pool, 'cus_solo')).toBe(false)
		expect(await customerBoughtTeamSeats(pool, 'cus_nobody')).toBe(false)
	})
	it('inspects the exact lines a reservation returned for a purch_<uuid> source', async () => {
		const input = command('in_syntheticDeskFlow', 2)
		const reserved = await runCreditCommand(store(), input)
		const creditLines = (
			'invoiceLines' in reserved ? (reserved.invoiceLines ?? []) : []
		).map(({ amountCents, description }) => ({ amountCents, description }))
		expect(creditLines).toEqual([
			{
				amountCents: -20000,
				description: `Crash Course team seat credit x 2 (${PURCHASE_A}, $100.00 per seat)`,
			},
		])
		expect(
			await runCreditCommand(store(), {
				...input,
				mode: 'inspect',
				invoice: { ...input.invoice, creditLines },
			}),
		).toMatchObject({ idempotent: true, state: 'reserved' })
	})
	it('prices a shared bulk coupon per purchase from checkout quantity and charge cents', async () => {
		await sharedCouponTeam()
		expect(await readCreditBalance(store(), scope)).toMatchObject({
			seats: 12,
			amountCents: 39800 + 224250,
		})
		// Stripe is read during discovery, with the purchase's own ids.
		expect(paymentReads.at(-1)).toEqual(
			expect.arrayContaining([
				{
					purchaseId: ADDON,
					chargeIdentifier: `ch_${fixtureKey(ADDON)}`,
					checkoutSessionIdentifier: `cs_${fixtureKey(ADDON)}`,
				},
			]),
		)
		const result = await runCreditCommand(store(), command('in_syntheticTeam', 6))
		expect(
			result.receipt.allocations.map((a) => [
				a.purchaseId,
				a.seats,
				a.perSeatCents,
				a.purchaseSeats,
				a.purchaseTotalCents,
			]),
		).toEqual([[ADDON, 6, 22425, 10, 224250]])
		expect(result.receipt.amountCents).toBe(134550)
		expect(await readCreditBalance(store(), scope)).toMatchObject({
			seats: 6,
			amountCents: 39800 + 4 * 22425,
		})
		for (const [fact, reason] of [
			// No checkout quantity: maxUses is the team total, not this purchase.
			[
				{ chargeCents: 224250, seats: null },
				'shared_bulk_coupon_source_hold_for_review',
			],
			[
				{ chargeCents: 224450, seats: 10 },
				'purchase_amount_disagrees_with_charge_hold_for_review',
			],
			[
				{ chargeCents: 224250, seats: 13 },
				'purchase_seats_exceed_bulk_coupon_hold_for_review',
			],
			[
				{ hold: 'source_charge_refunded_hold_for_review' },
				'source_charge_refunded_hold_for_review',
			],
		] as const) {
			stripeFacts.set(ADDON, fact)
			await expect(readCreditBalance(store(), scope)).rejects.toMatchObject({
				reason,
			})
		}
		stripeFacts.delete(ADDON)
		await expect(readCreditBalance(store(), scope)).rejects.toMatchObject({
			reason: 'source_payment_evidence_missing_hold_for_review',
		})
	})
	it('reads Stripe evidence before taking any purchase lock', async () => {
		await sharedCouponTeam()
		const probe = await pool.getConnection()
		lockCounts.length = 0
		probeLocks = async () => {
			const [rows] = await probe.query<RowDataPacket[]>(
				"SELECT COUNT(*) AS n FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = DATABASE() AND OBJECT_NAME = 'AI_Purchase'",
			)
			return Number(rows[0]!.n)
		}
		// Positive control: the probe does see a held purchase lock.
		const holder = await pool.getConnection()
		await holder.beginTransaction()
		await holder.query('SELECT id FROM AI_Purchase WHERE id = ? FOR UPDATE', [
			ADDON,
		])
		expect(await probeLocks()).toBeGreaterThan(0)
		await holder.rollback()
		holder.release()
		try {
			await runCreditCommand(store(), command('in_syntheticLockOrder', 2))
		} finally {
			probeLocks = null
			probe.release()
		}
		expect(lockCounts).toEqual([0])
	})
	it('imports a source-less historical line only with a desk-reviewed explicit source', async () => {
		await pool.query('DELETE FROM AI_Purchase')
		stripeFacts.clear()
		await pool.execute(
			"INSERT INTO AI_Coupon (id, maxUses) VALUES ('bulk_ten', 10)",
		)
		await teamPurchase({
			id: ADDON,
			coupon: 'bulk_ten',
			recorded: '2243',
			chargeCents: 224250,
			seats: 10,
		})
		// 6 seats at $224.25 actually paid, on a line that names no purchase.
		const input = historicalInvoice('in_syntheticExplicit', 6, 'paid', [
			{ description: 'Crash Course team credit', amountCents: -134550 },
		])
		const sources = [{ purchaseId: ADDON, seats: 6, perSeatCents: 22425 }]
		await expect(runCreditCommand(store(), input)).rejects.toMatchObject({
			reason: 'historical_credit_source_ambiguous',
		})
		for (const [changed, reason] of [
			[[{ ...sources[0]!, seats: 5 }], 'explicit_source_amount_mismatch'],
			[
				[{ ...sources[0]!, perSeatCents: 22430 }],
				'explicit_source_amount_mismatch',
			],
			[
				[{ ...sources[0]!, purchaseId: ORIGINAL }],
				'historical_credit_source_ineligible',
			],
			[[], 'explicit_sources_must_match_credit_lines'],
			[
				[sources[0]!, { ...sources[0]!, seats: 1, perSeatCents: 134550 }],
				'explicit_sources_duplicate_purchase',
			],
		] as const)
			await expect(
				runCreditCommand(store(), { ...input, sources: [...changed] }),
			).rejects.toMatchObject({ reason })
		await expect(
			runCreditCommand(store(), {
				...input,
				sources,
				invoice: {
					...input.invoice,
					creditLines: [
						{
							description: 'Crash Course team seat credit x 5',
							amountCents: -134550,
						},
					],
				},
			}),
		).rejects.toMatchObject({
			reason: 'explicit_source_contradicts_invoice_line',
		})
		await expect(
			runCreditCommand(store(), { ...input, mode: 'reserve', sources }),
		).rejects.toMatchObject({ reason: 'explicit_sources_backfill_only' })
		expect(
			await runCreditCommand(store(), { ...input, sources }),
		).toMatchObject({
			state: 'preview',
			receipt: {
				status: 'paid',
				amountCents: 134550,
				allocations: [
					{
						purchaseId: ADDON,
						seats: 6,
						perSeatCents: 22425,
						purchaseSeats: 10,
						purchaseTotalCents: 224250,
					},
				],
			},
		})
		expect(await spent()).toBe(0)
		const apply = { ...input, mode: 'backfill' as const, sources }
		expect(await runCreditCommand(store(), apply)).toMatchObject({
			state: 'paid',
		})
		expect(await readCreditBalance(store(), scope)).toMatchObject({
			seats: 4,
			amountCents: 89700,
		})
		expect(await runCreditCommand(store(), apply)).toMatchObject({
			idempotent: true,
		})
		await expect(
			runCreditCommand(store(), {
				...apply,
				sources: [{ purchaseId: ADDON, seats: 6, perSeatCents: 22430 }],
			}),
		).rejects.toMatchObject({
			reason: 'invoice_id_reused_with_changed_request',
		})
		expect(await spent()).toBe(6)
	})
	it('replays a two-source backfill only with the same sources, in any order', async () => {
		await sharedCouponTeam()
		const input = historicalInvoice('in_syntheticTwoSources', 2, 'paid', [
			{ description: 'Crash Course team credit', amountCents: -19900 },
			{ description: 'Crash Course team credit', amountCents: -22425 },
		])
		const original = { purchaseId: ORIGINAL, seats: 1, perSeatCents: 19900 }
		const addon = { purchaseId: ADDON, seats: 1, perSeatCents: 22425 }
		const apply = { ...input, mode: 'backfill' as const }
		expect(
			await runCreditCommand(store(), { ...apply, sources: [original, addon] }),
		).toMatchObject({ state: 'paid', receipt: { amountCents: 42325 } })
		expect(
			await runCreditCommand(store(), { ...apply, sources: [addon, original] }),
		).toMatchObject({ idempotent: true })
		for (const [sources, reason] of [
			// Stored [A, B] must not match [A, A].
			[[original, original], 'explicit_sources_duplicate_purchase'],
			[[original], 'invoice_id_reused_with_changed_request'],
			[
				[original, { ...addon, perSeatCents: 22430 }],
				'invoice_id_reused_with_changed_request',
			],
		] as const)
			await expect(
				runCreditCommand(store(), { ...apply, sources: [...sources] }),
			).rejects.toMatchObject({ reason })
		expect(await spent()).toBe(2)
	})
	it('imports a line priced from the rounded total as invoiced, only within that rounding', async () => {
		await sharedCouponTeam()
		// Invoiced at $224.30 a seat, from the stored $2,243 total.
		const input = historicalInvoice('in_syntheticAsInvoiced', 2, 'paid', [
			{ description: 'Crash Course team credit', amountCents: -44860 },
		])
		await expect(runCreditCommand(store(), input)).rejects.toMatchObject({
			reason: 'historical_credit_source_ambiguous',
		})
		const tooFar = historicalInvoice('in_syntheticTooFar', 2, 'paid', [
			{ description: 'Crash Course team credit', amountCents: -44900 },
		])
		await expect(
			runCreditCommand(store(), {
				...tooFar,
				sources: [{ purchaseId: ADDON, seats: 2, perSeatCents: 22450 }],
			}),
		).rejects.toMatchObject({
			reason: 'explicit_per_seat_cents_disagree_with_purchase',
		})
		expect(
			await runCreditCommand(store(), {
				...input,
				mode: 'backfill',
				sources: [{ purchaseId: ADDON, seats: 2, perSeatCents: 22430 }],
			}),
		).toMatchObject({
			state: 'paid',
			receipt: {
				amountCents: 44860,
				allocations: [
					{
						purchaseId: ADDON,
						seats: 2,
						perSeatCents: 22430,
						purchaseTotalCents: 224250,
					},
				],
			},
		})
		// What is left is priced at what was actually paid.
		expect(await readCreditBalance(store(), scope)).toMatchObject({
			seats: 10,
			amountCents: 39800 + 8 * 22425,
		})
	})
	it('imports a voided and a reissued explicit-source invoice for the same seat', async () => {
		await pool.query('DELETE FROM AI_Purchase')
		stripeFacts.clear()
		await pool.execute(
			"INSERT INTO AI_Coupon (id, maxUses) VALUES ('bulk_three', 3)",
		)
		// Unshared coupon and no checkout quantity: maxUses is this purchase.
		await teamPurchase({
			id: THREE_SEATS,
			coupon: 'bulk_three',
			recorded: '597',
			chargeCents: 59700,
			seats: null,
		})
		const sources = [{ purchaseId: THREE_SEATS, seats: 1, perSeatCents: 19900 }]
		const line = [{ description: 'Crash Course credit', amountCents: -19900 }]
		for (const [invoiceId, status, state] of [
			['in_syntheticVoided', 'void', 'released'],
			['in_syntheticReissued', 'open', 'reserved'],
		] as const)
			expect(
				await runCreditCommand(store(), {
					...historicalInvoice(invoiceId, 1, status, line),
					mode: 'backfill',
					sources,
				}),
			).toMatchObject({ state })
		expect(await spent()).toBe(1)
		expect(await readCreditBalance(store(), scope)).toMatchObject({
			seats: 2,
			amountCents: 39800,
		})
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
		}, payments)
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
		}, payments)
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
		}, payments)
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
