import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))

import { getSeatsTaken, parseSeatsTaken, seatsLeft } from './seats-taken-query'

// What mysql2 returns through the app pool: `[rows, fields]`, with `rows`,
// `insertId` and `rowsAffected` hung on the tuple by `preserveQueryResultShape`.
const mysql2Result = (rows: unknown[]) =>
	Object.assign([rows, [{ name: 'seats' }]], {
		insertId: '',
		rows,
		rowsAffected: 0,
	})

describe('seats taken from the mysql2 result shape', () => {
	beforeEach(() => mocks.execute.mockReset())

	it('reads the total from the [rows, fields] tuple', async () => {
		mocks.execute.mockResolvedValue(mysql2Result([{ seats: '46' }]))
		expect(await getSeatsTaken('product-1')).toBe(46)
	})

	it('reads the bare tuple and the rows-only shape too', () => {
		expect(parseSeatsTaken([[{ seats: 3 }], []])).toBe(3)
		expect(parseSeatsTaken({ rows: [{ seats: 4 }] })).toBe(4)
	})

	it('reads zero when the query says zero', () => {
		expect(parseSeatsTaken(mysql2Result([{ seats: 0 }]))).toBe(0)
		expect(parseSeatsTaken(mysql2Result([{ seats: '0' }]))).toBe(0)
	})

	it.each([
		['no rows', mysql2Result([])],
		['no seats column', mysql2Result([{}])],
		['null seats', mysql2Result([{ seats: null }])],
		['non-numeric seats', mysql2Result([{ seats: 'x' }])],
		['a header result', [{ affectedRows: 0 }, []]],
		['nothing', undefined],
	])('throws on %s instead of reading zero', async (_name, result) => {
		expect(() => parseSeatsTaken(result)).toThrow()
		mocks.execute.mockResolvedValue(result)
		await expect(getSeatsTaken('product-1')).rejects.toThrow()
	})
})

describe('seatsLeft', () => {
	it('is cap minus taken, never below zero', () => {
		expect(seatsLeft(10, 4)).toBe(6)
		expect(seatsLeft(10, 10)).toBe(0)
		expect(seatsLeft(10, 11)).toBe(0)
		expect(seatsLeft(1, 2)).toBe(0)
		expect(seatsLeft(null, 3)).toBe(0)
		expect(seatsLeft(undefined, 0)).toBe(0)
	})
})
