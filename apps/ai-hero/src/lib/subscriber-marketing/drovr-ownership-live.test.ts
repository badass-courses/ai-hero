import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findContactEventsByType: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/db', () => ({ db: {} }))
vi.mock('./drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {
		findContactEventsByType = mocks.findContactEventsByType
	},
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { resolveOwnedContactIds } from './drovr-ownership-live'

/** A Kit stop about contact c1: an owner fan-out candidate. */
const kitStop = (contactId = 'c1') =>
	({
		tenantId: 'org-aihero-shadow',
		contactId,
		journeyId: 'value-path-skills-course',
		type: 'contact.unsubscribed',
		occurredAt: '2026-09-26T05:00:00.000Z',
		idempotencyKey: `stop:${contactId}`,
	}) as never

describe('resolveOwnedContactIds', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.findContactEventsByType.mockResolvedValue([])
	})

	it('throws when the ownership read fails, so a durable step retries instead of dropping the stop', async () => {
		mocks.findContactEventsByType.mockRejectedValue(
			new Error('Vitess: connection reset'),
		)

		await expect(resolveOwnedContactIds([kitStop()])).rejects.toThrow(
			'Vitess: connection reset',
		)
		expect(mocks.log.error).toHaveBeenCalledWith('drovr.owner.resolve_failed', {
			contacts: 1,
			error: 'Vitess: connection reset',
		})
	})

	it('answers a real empty result as [] (candidates, none owned by drovr)', async () => {
		await expect(resolveOwnedContactIds([kitStop()])).resolves.toEqual([])
		expect(mocks.findContactEventsByType).toHaveBeenCalledTimes(1)
		expect(mocks.log.error).not.toHaveBeenCalled()
	})

	it('answers [] without a read when no event is an owner fan-out candidate', async () => {
		const shadowBirth = {
			...(kitStop() as object),
			type: 'contact.created',
		} as never
		await expect(resolveOwnedContactIds([shadowBirth])).resolves.toEqual([])
		expect(mocks.findContactEventsByType).not.toHaveBeenCalled()
	})

	it('returns the contacts drovr owns', async () => {
		mocks.findContactEventsByType.mockResolvedValue([
			{ providerEventId: 'drovr-owner:c1:value-path-skills-course' },
		])
		await expect(resolveOwnedContactIds([kitStop()])).resolves.toEqual(['c1'])
	})
})
