import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TeamSeatRedemptionDataSource } from '@/lib/team-seat-redemption'

const mocks = vi.hoisted(() => ({
	auth: vi.fn(),
	revalidate: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	dataSource: { current: null as TeamSeatRedemptionDataSource | null },
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.auth }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
vi.mock('@/server/logger', () => ({
	log: { info: mocks.info, error: mocks.error },
}))
// The real adapter, inngest and email wiring never load in this test.
vi.mock('@/lib/team-seat-redemption-drizzle', () => ({
	get drizzleTeamSeatRedemptionDataSource() {
		return mocks.dataSource.current
	},
}))
vi.mock('@/lib/team-manager-invitations-drizzle', () => ({}))

import { createFakeSeatDataSource } from '@/lib/team-seat-redemption.fixtures'

import { addTeamSeatsByEmailAction } from './actions'

const idle = { status: 'idle' as const, message: '', results: [] }

function form(emails: string) {
	const formData = new FormData()
	formData.set('purchaseId', 'purchase-team')
	formData.set('emails', emails)
	return formData
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.auth.mockResolvedValue({ session: { user: { id: 'user-owner' } } })
})

describe('addTeamSeatsByEmailAction', () => {
	it('refuses a signed-in non-manager server-side', async () => {
		const { dataSource } = createFakeSeatDataSource({
			seats: 5,
			roles: { 'user-learner': ['learner'] },
		})
		mocks.dataSource.current = dataSource
		mocks.auth.mockResolvedValue({ session: { user: { id: 'user-learner' } } })

		const state = await addTeamSeatsByEmailAction(idle, form('a@example.com'))

		expect(state).toEqual({
			status: 'error',
			message: 'You do not have permission to manage this team.',
			results: [],
		})
		expect(dataSource.redeemFullPriceCoupon).not.toHaveBeenCalled()
		expect(mocks.revalidate).not.toHaveBeenCalled()
	})

	it('refuses an anonymous request', async () => {
		const { dataSource } = createFakeSeatDataSource({ seats: 5 })
		mocks.dataSource.current = dataSource
		mocks.auth.mockResolvedValue({ session: null })

		const state = await addTeamSeatsByEmailAction(idle, form('a@example.com'))

		expect(state.status).toBe('error')
		expect(dataSource.loadPurchase).not.toHaveBeenCalled()
	})

	it('adds until seats run out and logs counts without emails', async () => {
		const { dataSource } = createFakeSeatDataSource({ seats: 2 })
		mocks.dataSource.current = dataSource

		const state = await addTeamSeatsByEmailAction(
			idle,
			form('a@example.com b@example.com a@example.com c@example.com'),
		)

		expect(state.status).toBe('success')
		expect(state.message).toBe('Added 2 learners.')
		expect(state.results.map(({ status }) => status)).toEqual([
			'added',
			'added',
			'no-seats-left',
		])
		expect(mocks.revalidate).toHaveBeenCalledWith('/team')
		expect(mocks.info).toHaveBeenCalledWith('team.seats.added-by-email', {
			actorUserId: 'user-owner',
			purchaseId: 'purchase-team',
			addedCount: 2,
			emailFailedCount: 0,
			alreadyHadAccessCount: 0,
			noSeatsLeftCount: 1,
			invalidCount: 0,
			failedCount: 0,
		})
		expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('@')
	})
})
