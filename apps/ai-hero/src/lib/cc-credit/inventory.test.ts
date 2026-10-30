import { describe, expect, it, vi } from 'vitest'
import { inventoryCredits, type HistoricalLine } from './inventory'
import type { CreditReceipt } from './domain'

async function* items<T>(values: T[]) {
	yield* values
}
const receipt = (
	invoiceId: string,
	status: CreditReceipt['status'] = 'paid',
): CreditReceipt => ({
	invoiceId,
	stripeCustomerId: 'cus_synthetic',
	requestHash: 'hash',
	seats: 2,
	amountCents: 20000,
	currency: 'usd',
	status,
	allocations: [
		{
			purchaseId: 'purch_synthetic',
			seats: 2,
			perSeatCents: 10000,
			purchaseSeats: 3,
			purchaseTotalCents: 30000,
		},
	],
})
describe('read-only historical CC invoice inventory', () => {
	it('reports counts and holds double-use plans even though each invoice alone would fit', async () => {
		const preview = vi.fn(async (input: { invoiceId: string }) => ({
			ok: true,
			result: {
				receipt: receipt(
					input.invoiceId,
					input.invoiceId === 'void' ? 'released' : 'paid',
				),
				remainingByPurchase: { purch_synthetic: 3 },
			},
		}))
		const plan = await inventoryCredits(
			{
				invoices: items(
					['none', 'first', 'second', 'ambiguous', 'void'].map((id) => ({
						id,
						customer: 'cus_synthetic',
					})),
				),
				lines: (id) =>
					items(
						id === 'none'
							? [{ description: 'Other product', amount: 1 }]
							: [
									{
										description:
											id === 'ambiguous'
												? 'Crash Course credit'
												: 'Crash Course team seat credit x 2 (purch_synthetic)',
										amount: -20000,
									},
								],
					),
				preview,
			},
			'test-run',
		)
		expect(plan.counts).toEqual({
			scannedInvoices: 5,
			matchedInvoices: 4,
			previewed: 2,
			alreadyLedgered: 0,
			held: 2,
			notTeamLedger: 0,
			reserved: 0,
			paid: 1,
			released: 1,
		})
		expect(
			plan.records
				.filter((row) => row.state === 'hold')
				.map((row) => row.reason),
		).toEqual([
			'historical_invoices_double_spend_same_purchase',
			'historical_credit_seat_count_or_amount_ambiguous',
		])
		expect(preview).toHaveBeenCalledTimes(3)
	})
	it('matches "Crash Course team credit" lines and holds unrecognized negative lines on C5 invoices', async () => {
		const preview = vi.fn(async (input: { invoiceId: string }) => ({
			ok: true,
			result: {
				receipt: receipt(input.invoiceId),
				remainingByPurchase: { purch_synthetic: 3 },
			},
		}))
		const c5 = { price: { product: 'prod_c5' }, amount: 99500 }
		const lines: Record<string, HistoricalLine[]> = {
			team: [
				{ ...c5, description: 'Cohort seats' },
				{ description: 'Crash Course team credit', amount: -59700 },
			],
			adjusted: [
				{ ...c5, description: 'Cohort seats' },
				{ description: 'Prior purchase adjustment', amount: -59700 },
			],
			unrelated: [
				{
					price: { product: 'prod_other' },
					description: 'Other product',
					amount: 1000,
				},
				{ description: 'Proration', amount: -500 },
			],
		}
		const plan = await inventoryCredits(
			{
				invoices: items(
					Object.keys(lines).map((id) => ({ id, customer: 'cus_synthetic' })),
				),
				lines: (id) => items(lines[id]!),
				preview,
				c5Products: new Set(['prod_c5']),
			},
			'test-run',
		)
		expect(plan.counts).toMatchObject({
			scannedInvoices: 3,
			matchedInvoices: 2,
			held: 2,
		})
		expect(plan.records.map((row) => [row.invoiceId, row.reason])).toEqual([
			// No "x N" on the line: needs a desk-reviewed explicit-source import.
			['team', 'historical_credit_seat_count_or_amount_ambiguous'],
			['adjusted', 'historical_unrecognized_negative_line_hold_for_review'],
		])
		expect(preview).not.toHaveBeenCalled()
	})
	it('reports individual credits as not team ledger only for customers with no team purchase', async () => {
		const c5 = { price: { product: 'prod_c5' }, amount: 99500 }
		const individual = {
			description:
				'Credit: earlier AI Coding Crash Course purchase (included in Software Factories)',
			amount: -29900,
		}
		const lines: Record<string, HistoricalLine[]> = {
			personal: [
				{ ...c5, description: 'Cohort seat' },
				{ description: 'Crash Course credit', amount: -19900 },
			],
			bundle: [{ ...c5, description: 'Software Factories' }, individual],
			teamBuyer: [{ ...c5, description: 'Software Factories' }, individual],
			teamWording: [
				{ ...c5, description: 'Cohort seats' },
				{ description: 'Crash Course team credit', amount: -59700 },
			],
		}
		const teamCustomer = vi.fn(async (id: string) => id === 'cus_team')
		const invoices = () =>
			items(
				Object.keys(lines).map((id) => ({
					id,
					customer: id === 'teamBuyer' ? 'cus_team' : `cus_${id}`,
				})),
			)
		const deps = {
			lines: (id: string) => items(lines[id]!),
			preview: vi.fn(),
			c5Products: new Set(['prod_c5']),
		}
		const plan = await inventoryCredits(
			{ ...deps, invoices: invoices(), teamCustomer },
			'test-run',
		)
		expect(plan.counts).toMatchObject({
			matchedInvoices: 4,
			notTeamLedger: 2,
			held: 2,
		})
		expect(plan.records.map((row) => [row.invoiceId, row.state])).toEqual([
			['personal', 'not_team_ledger'],
			['bundle', 'not_team_ledger'],
			['teamBuyer', 'hold'],
			['teamWording', 'hold'],
		])
		// A line that says team is never waved through on the DB lookup.
		expect(teamCustomer.mock.calls.map(([id]) => id)).toEqual([
			'cus_personal',
			'cus_bundle',
			'cus_team',
		])
		const unknown = await inventoryCredits(
			{ ...deps, invoices: invoices() },
			'test-run',
		)
		expect(unknown.counts).toMatchObject({ notTeamLedger: 0, held: 4 })
		expect(deps.preview).not.toHaveBeenCalled()
	})
	it('does not project already-ledgered receipts twice and treats source outages as holds', async () => {
		const plan = await inventoryCredits(
			{
				invoices: items(
					['existing', 'unavailable'].map((id) => ({
						id,
						customer: { id: 'cus_synthetic' },
					})),
				),
				lines: () =>
					items([
						{
							description: 'Crash Course credit x 2 (purch_synthetic)',
							amount: -20000,
						},
					]),
				preview: async (input) =>
					input.invoiceId === 'existing'
						? {
								ok: true,
								result: { receipt: receipt('existing'), idempotent: true },
							}
						: { ok: false, result: { reason: 'preview_unavailable' } },
			},
			'test-run',
		)
		expect(plan.counts).toMatchObject({
			matchedInvoices: 2,
			alreadyLedgered: 1,
			held: 1,
			previewed: 0,
		})
	})
})
