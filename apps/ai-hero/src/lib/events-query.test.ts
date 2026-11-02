import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	log: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: { query: { contentResource: { findFirst: mocks.findFirst } } },
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/lib/emails-query', () => ({ createEmail: vi.fn() }))

import { getEvent } from './events-query'

describe('getEvent', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('is null with a debug log and no error log when no row matches', async () => {
		mocks.findFirst.mockResolvedValue(undefined)

		await expect(getEvent('missing-event')).resolves.toBeNull()
		expect(mocks.log.debug).toHaveBeenCalledWith('event.not_found', {
			slugOrId: 'missing-event',
		})
		expect(mocks.log.error).not.toHaveBeenCalled()
	})

	it('still logs event.parse.error for a malformed row', async () => {
		mocks.findFirst.mockResolvedValue({ id: 'event-1', type: 'event' })

		await expect(getEvent('event-1')).resolves.toBeNull()
		expect(mocks.log.error).toHaveBeenCalledWith(
			'event.parse.error',
			expect.objectContaining({ eventId: 'event-1' }),
		)
	})
})
