import { describe, expect, it } from 'vitest'
import {
	decodeAttempt,
	attemptStateAt,
	refusalObservation,
	ObservedKnownNotAppliedOutcome,
} from './attempt-evidence'

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
	it('preserves legacy unknown and exact observed refusal times without inventing one', () => {
		const outcome = {
			type: 'KnownNotApplied' as const,
			reason: 'ProviderRefused' as const,
		}
		const legacy = decodeAttempt({ ...row, status: outcome.type, outcome })
		expect(legacy.outcome).toEqual(outcome)
		expect(refusalObservation(outcome)).toEqual({ type: 'Unknown' })
		expect(ObservedKnownNotAppliedOutcome.safeParse(outcome).success).toBe(
			false,
		)
		const current = { ...outcome, observedAt: '2026-09-04T17:00:00.123Z' }
		expect(
			decodeAttempt({ ...row, status: outcome.type, outcome: current }).outcome,
		).toEqual(current)
		expect(refusalObservation(current)).toEqual({
			type: 'Known',
			observedAt: current.observedAt,
		})
		for (const observedAt of [
			null,
			'',
			'not-a-time',
			'2026-09-04T17:00:00Z',
			'2026-09-04T17:00:00.123+00:00',
			'2026-09-04T16:59:59.999Z',
		]) {
			expect(() =>
				decodeAttempt({
					...row,
					status: outcome.type,
					outcome: { ...outcome, observedAt },
				}),
			).toThrow()
		}
		expect(() =>
			decodeAttempt({
				...row,
				status: 'HeldUncertain',
				outcome: {
					type: 'HeldUncertain',
					reason: 'Unknown',
					observedAt: current.observedAt,
				},
			}),
		).toThrow()
	})
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
