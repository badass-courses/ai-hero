import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const uri = process.env.AIH_CC_CREDIT_MYSQL_SERVER_URL
const suite = uri ? describe : describe.skip
const database = `aih_cc_credit_${randomUUID().replaceAll('-', '')}`
const migration = readFileSync(
	new URL('./migrations/20261028_ai_hero_cc_credit.sql', import.meta.url),
	'utf8',
)

/** Only the disposable server started by scripts/test-mysql.sh. */
function testServer(raw: string) {
	const url = new URL(raw)
	if (
		url.protocol !== 'mysql:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
		url.port === '3307' ||
		url.pathname !== '/mysql' ||
		url.username !== 'root' ||
		url.password !== 'aih_test_password'
	)
		throw new Error('unsafe-cc-credit-migration-test-server')
	return raw
}

suite('Crash Course credit migration against disposable MySQL', () => {
	let connection: Connection | undefined
	let created = false
	beforeAll(async () => {
		connection = await mysql.createConnection({
			uri: testServer(uri!),
			multipleStatements: true,
			timezone: 'Z',
		})
		await connection.query(`CREATE DATABASE \`${database}\``)
		created = true
		await connection.query(`USE \`${database}\``)
		await connection.query(
			"SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'",
		)
		await connection.query(migration)
	})

	afterAll(async () => {
		if (created) await connection!.query(`DROP DATABASE \`${database}\``)
		await connection?.end()
	})

	const insertReservation = async (invoiceId: string, status = 'reserved') =>
		connection!.execute(
			`INSERT INTO AI_CcCreditReservation
			(invoiceId, stripeCustomerId, requestHash, seats, amountCents, currency, status, audit, createdAt, updatedAt)
			VALUES (?, 'cus_synthetic', ?, 2, 50000, 'usd', ?, '{}', NOW(3), NOW(3))`,
			[invoiceId, 'a'.repeat(64), status],
		)
	const insertAllocation = async (
		invoiceId: string,
		purchaseId: string,
		seats = 1,
	) =>
		connection!.execute(
			`INSERT INTO AI_CcCreditAllocation
			(invoiceId, purchaseId, seats, perSeatCents, purchaseSeats, purchaseTotalCents)
			VALUES (?, ?, ?, 25000, 3, 75000)`,
			[invoiceId, purchaseId, seats],
		)

	it('reruns without losing a reservation or its multiple source allocations', async () => {
		await insertReservation('in_synthetic_repeat')
		await insertAllocation('in_synthetic_repeat', 'purch_synthetic_a')
		await insertAllocation('in_synthetic_repeat', 'purch_synthetic_b')
		await connection!.query(migration)
		const [receipts] = await connection!.query<RowDataPacket[]>(
			"SELECT seats, amountCents, status FROM AI_CcCreditReservation WHERE invoiceId = 'in_synthetic_repeat'",
		)
		expect(receipts).toMatchObject([
			{ seats: 2, amountCents: 50000, status: 'reserved' },
		])
		const [allocations] = await connection!.query<RowDataPacket[]>(
			"SELECT purchaseId FROM AI_CcCreditAllocation WHERE invoiceId = 'in_synthetic_repeat' ORDER BY purchaseId",
		)
		expect(allocations.map((row) => row.purchaseId)).toEqual([
			'purch_synthetic_a',
			'purch_synthetic_b',
		])
	})

	it('rejects invoice replay inserts and duplicate invoice/purchase allocations', async () => {
		await insertReservation('in_synthetic_unique')
		await expect(
			insertReservation('in_synthetic_unique'),
		).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' })
		await insertAllocation('in_synthetic_unique', 'purch_synthetic_shared')
		await expect(
			insertAllocation('in_synthetic_unique', 'purch_synthetic_shared'),
		).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' })
		// A source can fund more than one invoice. Application locking, not a
		// purchase-id uniqueness constraint, must enforce its seat capacity.
		await insertReservation('in_synthetic_other')
		await insertAllocation('in_synthetic_other', 'purch_synthetic_shared')
	})

	it('compares provider ids case-sensitively', async () => {
		await insertReservation('in_synthetic_Case')
		await insertReservation('in_synthetic_case')
		const [rows] = await connection!.query<RowDataPacket[]>(
			"SELECT invoiceId FROM AI_CcCreditReservation WHERE invoiceId = 'in_synthetic_Case'",
		)
		expect(rows.map((row) => row.invoiceId)).toEqual(['in_synthetic_Case'])
	})

	it('rejects unknown states and negative unsigned seat counts', async () => {
		await expect(
			insertReservation('in_synthetic_bad_status', 'unknown'),
		).rejects.toBeDefined()
		await expect(
			insertAllocation('in_synthetic_bad_seats', 'purch_synthetic_bad', -1),
		).rejects.toMatchObject({ code: 'ER_WARN_DATA_OUT_OF_RANGE' })
	})

	it('rolls back receipt and allocations together on a failed transaction', async () => {
		await connection!.beginTransaction()
		try {
			await insertReservation('in_synthetic_rollback')
			await insertAllocation(
				'in_synthetic_rollback',
				'purch_synthetic_rollback',
			)
			await expect(
				insertAllocation('in_synthetic_rollback', 'purch_synthetic_rollback'),
			).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' })
		} finally {
			await connection!.rollback()
		}
		for (const table of ['AI_CcCreditReservation', 'AI_CcCreditAllocation']) {
			const [rows] = await connection!.query<RowDataPacket[]>(
				`SELECT invoiceId FROM ${table} WHERE invoiceId = 'in_synthetic_rollback'`,
			)
			expect(rows).toEqual([])
		}
	})
})
