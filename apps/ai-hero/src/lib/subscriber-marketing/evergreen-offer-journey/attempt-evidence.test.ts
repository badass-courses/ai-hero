import { describe, expect, it } from 'vitest'
import { decodeAttempt, attemptStateAt } from './attempt-evidence'

const row = {
	format: 'evergreen-offer-journey.attempt.v1',
	idempotencyKey: 'journey:message',
	journeyId: 'journey',
	claimToken: 'dcbf2377-2c3f-4b12-b67e-a732352f17ad',
	status: 'Claimed',
	claimedAt: new Date('2026-09-04T17:00:00Z'),
	leaseExpiresAt: new Date('2026-09-04T17:01:00Z'),
	outcome: null,
}
describe('provider attempt evidence', () => {
	it('projects crashed or expired claims as held, never retryable', () => {
		const claim = decodeAttempt(row)
		expect(attemptStateAt(claim, new Date('2026-09-04T17:00:30Z'))).toBe(
			'Claimed',
		)
		expect(attemptStateAt(claim, row.leaseExpiresAt)).toBe('HeldUncertain')
		expect(attemptStateAt(claim, new Date('2027-01-01T00:00:00Z'))).toBe(
			'HeldUncertain',
		)
	})
	it('rejects arbitrary statuses and invalid ownership evidence', () => {
		for (const bad of [
			{ status: 'Retryable' },
			{ claimToken: '' },
			{ leaseExpiresAt: row.claimedAt },
			{ outcome: { type: 'Accepted', providerReceiptId: '*' } },
		]) {
			expect(() => decodeAttempt({ ...row, ...bad })).toThrow()
		}
	})
	it('requires accepted evidence to match the status and contain exact receipt time', () => {
		expect(() => decodeAttempt({ ...row, status: 'Accepted' })).toThrow()
		const accepted = decodeAttempt({
			...row,
			status: 'Accepted',
			outcome: {
				type: 'Accepted',
				providerReceiptId: 'receipt-1',
				appliedAt: '2026-09-04T17:00:10.000Z',
			},
		})
		expect(attemptStateAt(accepted, new Date('2027-01-01'))).toBe('Accepted')
	})
})
