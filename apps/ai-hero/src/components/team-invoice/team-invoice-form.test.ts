import { describe, expect, it, vi } from 'vitest'

vi.mock('./team-invoice-actions', () => ({ requestTeamInvoice: vi.fn() }))

import { teamInvoiceResultMessage } from './team-invoice-form'

describe('teamInvoiceResultMessage', () => {
	it('confirms where the invoice went', () => {
		expect(
			teamInvoiceResultMessage({ kind: 'sent', email: 'billing@example.test' }),
		).toEqual({
			tone: 'success',
			text: 'Invoice sent to billing@example.test. Once it is paid, you assign seats from your account.',
		})
	})

	it('fails closed on price with the agreed words', () => {
		expect(teamInvoiceResultMessage({ kind: 'price-unavailable' })).toEqual({
			tone: 'error',
			text: 'Price unavailable, contact us.',
		})
	})

	it('words a request by when it will be answered', () => {
		expect(
			teamInvoiceResultMessage({
				kind: 'requested',
				email: 'a@example.test',
				when: 'seats-open',
			}).text,
		).toMatch(/as soon as seats open/)
		expect(
			teamInvoiceResultMessage({
				kind: 'requested',
				email: 'a@example.test',
				when: 'working-day',
			}).text,
		).toMatch(/within a working day/)
	})

	it('never uses an em dash', () => {
		const kinds = [
			{ kind: 'sent', email: 'a@example.test' },
			{ kind: 'requested', email: 'a@example.test', when: 'seats-open' },
			{ kind: 'price-unavailable' },
			{ kind: 'not-on-sale' },
			{ kind: 'contact-us' },
			{ kind: 'rate-limited' },
			{ kind: 'error' },
		] as const
		for (const result of kinds) {
			expect(teamInvoiceResultMessage(result).text).not.toContain('—')
		}
	})
})
