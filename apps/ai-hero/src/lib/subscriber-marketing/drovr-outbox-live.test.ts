import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DrovrOutboxUnavailableError } from './drovr-outbox'

const mocks = vi.hoisted(() => ({ openGates: vi.fn() }))

vi.mock('@/db', () => ({ db: {} }))
vi.mock('./drovr-outbox-drizzle', () => ({
	createDrizzleDrovrOutboxStore: () => ({ openGates: mocks.openGates }),
}))

import { openDrovrOutboxStopsLive } from './drovr-outbox-live'

const gate = (eventType: string, status = 'pending') => ({
	contactId: 'contact-1',
	journeyId: 'crash-course-evergreen-offer',
	endpoint: 'events',
	eventType,
	status,
	nextAttemptAt: '2026-09-30T12:05:00.000Z',
	occurredAt: '2026-09-30T12:00:00.000Z',
})

describe('openDrovrOutboxStopsLive (row 204b)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubEnv('VERCEL_ENV', 'production')
	})

	it("reads this deployment's target and keeps only the stops", async () => {
		mocks.openGates.mockResolvedValue([
			gate('contact.created'),
			gate('purchase.recorded'),
			gate('contact.unsubscribed', 'rejected'),
		])
		const stops = await openDrovrOutboxStopsLive(['contact-1'])
		expect(mocks.openGates).toHaveBeenCalledWith({
			target: 'production',
			contactIds: ['contact-1'],
		})
		expect(stops.map((stop) => stop.eventType)).toEqual([
			'purchase.recorded',
			'contact.unsubscribed',
		])
	})

	it('reads no table as nothing owed', async () => {
		mocks.openGates.mockRejectedValue(
			new DrovrOutboxUnavailableError(new Error('errno 1146')),
		)
		expect(await openDrovrOutboxStopsLive(['contact-1'])).toEqual([])
	})

	it('throws any other failure, so the caller retries and never posts unchecked', async () => {
		mocks.openGates.mockRejectedValue(new Error('Vitess: connection reset'))
		await expect(openDrovrOutboxStopsLive(['contact-1'])).rejects.toThrow(
			'Vitess: connection reset',
		)
	})

	it('reads nothing for no contacts', async () => {
		expect(await openDrovrOutboxStopsLive([])).toEqual([])
		expect(mocks.openGates).not.toHaveBeenCalled()
	})
})
