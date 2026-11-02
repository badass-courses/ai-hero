import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
	allocate,
	allocationTotal,
	creditBalance,
	PURCHASE_ID,
	purchaseCents,
	settleStatus,
	source,
} from './domain'

const sources = [
	source({
		purchaseId: 'purch_low',
		purchaseSeats: 3,
		chargeCents: 30000,
		recordedAmount: '300.000000000000000000000000000000',
	}),
	source({
		purchaseId: 'purch_high',
		purchaseSeats: 2,
		chargeCents: 50000,
		recordedAmount: '500.00',
	}),
]
describe('CC seat-credit arithmetic and lifecycle', () => {
	it('allocates highest paid seats first and counts reserved/paid spending', () => {
		expect(
			allocate(sources, new Map(), 3).map((a) => [
				a.purchaseId,
				a.seats,
				a.perSeatCents,
			]),
		).toEqual([
			['purch_high', 2, 25000],
			['purch_low', 1, 10000],
		])
		expect(creditBalance(sources, new Map([['purch_high', 1]]))).toEqual({
			seats: 4,
			amountCents: 55000,
		})
	})
	it('refuses overspend, malformed money and fractional per-seat cents', () => {
		expect(() => allocate(sources, new Map(), 6)).toThrow('insufficient_credit')
		expect(() => creditBalance(sources, new Map([['purch_high', 3]]))).toThrow(
			'ledger_overdrawn',
		)
		for (const amount of ['-1', 'NaN', '1e3', '0', '0.001', '9007199254740992'])
			expect(() => purchaseCents(amount)).toThrow()
		expect(() =>
			source({
				purchaseId: 'p',
				purchaseSeats: 3,
				chargeCents: 100,
				recordedAmount: '1',
			}),
		).toThrow('fractional_per_seat')
		expect(purchaseCents('224.300000')).toBe(22430)
	})
	it('prices seats from the Stripe charge, not a rounded Purchase.totalAmount', () => {
		// $2,242.50 paid for 10 seats, stored as $2,243.
		expect(
			source({
				purchaseId: 'purch_rounded',
				purchaseSeats: 10,
				chargeCents: 224250,
				recordedAmount: '2243.000000000000000000000000000000',
			}),
		).toEqual({
			purchaseId: 'purch_rounded',
			purchaseSeats: 10,
			purchaseTotalCents: 224250,
			perSeatCents: 22425,
		})
		expect(() =>
			source({
				purchaseId: 'purch_far',
				purchaseSeats: 10,
				chargeCents: 224250,
				recordedAmount: '2244',
			}),
		).toThrow('purchase_amount_disagrees_with_charge')
	})
	it('reads whole purch_<uuid> ids out of credit line descriptions', () => {
		const id = 'purch_3f8e2c1a-9b7d-4e6f-a5c4-1d2e3f4a5b6c'
		expect(
			`Crash Course team seat credit x 2 (${id}, $224.25 per seat)`.match(
				PURCHASE_ID,
			),
		).toEqual([id])
	})
	it('only releases reserved invoices on verified void and never resurrects terminal rows', () => {
		expect(settleStatus('reserved', 'paid')).toBe('paid')
		expect(settleStatus('reserved', 'void')).toBe('released')
		expect(settleStatus('reserved', 'uncollectible')).toBe('reserved')
		expect(settleStatus('paid', 'paid')).toBe('paid')
		expect(settleStatus('released', 'void')).toBe('released')
		expect(() => settleStatus('released', 'paid')).toThrow()
		expect(() => settleStatus('paid', 'void')).toThrow()
		expect(() => settleStatus('paid', 'open')).toThrow()
	})
	it('preserves seat and cent conservation for generated allocations', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						capacity: fc.integer({ min: 1, max: 30 }),
						price: fc.integer({ min: 1, max: 100000 }),
						usedSeed: fc.nat(),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				fc.nat(),
				(rows, wanted) => {
					const inputs = rows.map((row, i) => ({
						purchaseId: `p-${i}`,
						purchaseSeats: row.capacity,
						perSeatCents: row.price,
						purchaseTotalCents: row.capacity * row.price,
					}))
					const spent = new Map(
						rows.map((row, i) => [`p-${i}`, row.usedSeed % (row.capacity + 1)]),
					)
					const balance = creditBalance(inputs, spent)
					if (!balance.seats) return
					const seats = (wanted % balance.seats) + 1
					const allocations = allocate(inputs, spent, seats)
					expect(allocations.reduce((n, a) => n + a.seats, 0)).toBe(seats)
					expect(allocationTotal(allocations)).toBeLessThanOrEqual(
						balance.amountCents,
					)
					for (const a of allocations)
						expect(a.seats + spent.get(a.purchaseId)!).toBeLessThanOrEqual(
							a.purchaseSeats,
						)
					for (let i = 1; i < allocations.length; i++)
						expect(allocations[i - 1]!.perSeatCents).toBeGreaterThanOrEqual(
							allocations[i]!.perSeatCents,
						)
				},
			),
			{ numRuns: 1000 },
		)
	})
})
