import { describe, expect, it } from 'vitest'
import {
	retainedRetryOutcome,
	type OwnedRetryEvent,
} from './contact-sync-retry-owned-events'
import type { DrovrOutboxStatus } from './drovr-outbox'

const key = 'a'.repeat(64)
const record: OwnedRetryEvent = {
	event: {
		tenantId: 'org-aihero',
		contactId: 'synthetic-owned-disposition',
		journeyId: 'contact-directory',
		type: 'contact.profile.updated',
		idempotencyKey: 'synthetic-shared-wire-key',
		occurredAt: '2032-01-01T00:00:00.000Z',
		payload: {
			profileVersion: 3,
			email: 'learner@example.test',
			firstName: null,
			holds: [],
		},
	},
	clampAt: Date.parse('2032-01-01T00:00:00.000Z'),
	delivered: false,
	status: 'pending',
	outboxKey: key,
}

describe('fresh retained retry disposition', () => {
	it.each(['pending', 'deferred'] as const)(
		'only %s work can reach the send boundary',
		(status) => {
			expect(retainedRetryOutcome(record, [{ key, status }])).toBeUndefined()
		},
	)
	it.each([
		['delivered', { accepted: 0, rejected: 0, alreadyDelivered: true }],
		['held', { accepted: 0, rejected: 0, retainedHeld: 1 }],
		['rejected', { accepted: 0, rejected: 0, retainedRejected: 1 }],
	] satisfies [DrovrOutboxStatus, object][])(
		'reports retained %s without fake new HTTP counts',
		(status, expected) => {
			expect(retainedRetryOutcome(record, [{ key, status }])).toEqual(expected)
		},
	)
	it('does not let another full scope with the same wire key authorize or retire this member', () => {
		expect(() =>
			retainedRetryOutcome(record, [
				{ key: 'b'.repeat(64), status: 'delivered' },
			]),
		).toThrow(/RetryDisposition:/)
		expect(() => retainedRetryOutcome(record, [])).toThrow(/RetryDisposition:/)
		expect(() =>
			retainedRetryOutcome(record, [
				{ key, status: 'pending' },
				{ key: 'b'.repeat(64), status: 'delivered' },
			]),
		).toThrow(/RetryDisposition:/)
	})
	it('permits only an unsubscribe to use the storage-validated local supersession receipt', () => {
		expect(() =>
			retainedRetryOutcome(record, [{ key, status: 'superseded' }]),
		).toThrow(/RetryDisposition:/)
		const unsubscribe = {
			...record,
			event: {
				...record.event,
				type: 'contact.unsubscribed' as const,
				payload: undefined,
			},
		}
		expect(
			retainedRetryOutcome(unsubscribe, [{ key, status: 'superseded' }]),
		).toEqual({ accepted: 0, rejected: 0, supersededUnsubscribes: 1 })
	})
})
