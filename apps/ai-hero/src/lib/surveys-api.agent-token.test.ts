import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			contentResource: { findMany: mocks.findMany },
		},
	},
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { listSurveysForApi } from '@/lib/surveys-api'
import { buildPersonalAccessTokenAbility } from '@/server/pat-scopes'

describe('survey definition reads for content PATs', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.findMany.mockResolvedValue([])
	})

	it('allows content:read without requiring manage all', async () => {
		const ability = buildPersonalAccessTokenAbility(['content:read'])

		await expect(listSurveysForApi({ ability })).resolves.toEqual([])
		expect(ability.cannot('manage', 'all')).toBe(true)
		expect(mocks.findMany).toHaveBeenCalledOnce()
	})
})
