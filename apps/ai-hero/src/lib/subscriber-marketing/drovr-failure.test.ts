import { describe, expect, it } from 'vitest'
import { drovrFailureReason } from './drovr-failure'
import type { SideEffectIntent } from './types'

describe('drovr failure reason boundary', () => {
	it('keeps fixed classes and refuses dynamic review reasons and provider messages', () => {
		const row: SideEffectIntent = {
			id: 'row-1', nextActionId: 'next-1', contactId: 'contact-1',
			provider: 'kit', type: 'send-evergreen-email', status: 'failed',
			idempotencyKey: 'local-key', gates: [], reviewReasons: ['kit-400'],
			metadata: { lastError: 'learner@example.com cannot subscribe' },
			createdAt: '2026-09-24T16:00:00.000Z',
		}
		expect(drovrFailureReason(row)).toEqual({ reasonClass: 'kit-400', reason: 'kit-400' })
		expect(drovrFailureReason({ ...row, reviewReasons: ['learner@example.com'] })).toEqual({
			reasonClass: 'executor-failed', reason: 'executor-failed',
		})
	})
})
