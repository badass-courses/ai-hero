import { beforeEach, describe, expect, it, vi } from 'vitest'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/server/logger', () => ({ log }))
vi.mock('@/db', () => ({}))

import type { LearningTeamMembers } from '@/lib/analytics/learning-teams'

import {
	loadTeamProgressForViewer,
	managedTeamIds,
	type TeamProgressDeps,
} from './team-progress'

const member = (userId: string) => ({
	userId,
	email: `${userId}@example.test`,
	name: null,
	redeemedAt: '2026-10-01T00:00:00.000Z',
	signedIn: true,
	lastActiveAt: null,
	lessonsCompleted: 1,
	workshops: { started: 1, completed: 0, total: 4 },
})

/** A fake reader that honors onlyUserId the way the SQL does. */
function teamsReader(teams: Record<string, string[]>) {
	return vi.fn(
		async (
			...[teamId, options]: Parameters<TeamProgressDeps['readMembers']>
		) => {
			const ids = teams[teamId]
			if (!ids) throw new Error(`unknown team ${teamId}`)
			const members = ids
				.filter((id) => !options.onlyUserId || id === options.onlyUserId)
				.map(member)
				.map(({ userId, ...rest }) =>
					options.includeUserIds ? { userId, ...rest } : rest,
				)
			return {
				asOf: '2026-10-29T12:00:00.000Z',
				pii: true,
				team: {
					teamId,
					product: { id: 'product', name: 'Synthetic' },
					seats: {
						bought: 5,
						redeemed: ids.length,
						unredeemed: 5 - ids.length,
					},
					organization: { id: 'org', name: "buyer@example.test's Team" },
				},
				members,
			} satisfies LearningTeamMembers
		},
	)
}

const teams = {
	'team-a': ['u-a1', 'u-a2'],
	'team-b': ['u-b1'],
}

describe('team progress authorization', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('only counts active bulk purchases as managed teams', () => {
		expect(
			managedTeamIds([
				{ bulkCouponId: 'team-a', status: 'Valid' },
				{ bulkCouponId: 'team-a', status: 'Restricted' },
				{ bulkCouponId: 'team-r', status: 'Refunded' },
				{ bulkCouponId: null, status: 'Valid' },
			]),
		).toEqual(['team-a'])
	})

	it('shows a manager every member of their own team only', async () => {
		const readMembers = teamsReader(teams)
		const blocks = await loadTeamProgressForViewer({
			viewerId: 'u-owner',
			managedPurchases: [{ bulkCouponId: 'team-a', status: 'Valid' }],
			deps: { listOwnSeatTeamIds: async () => [], readMembers },
		})
		expect(readMembers).toHaveBeenCalledTimes(1)
		expect(readMembers).toHaveBeenCalledWith('team-a', {
			includeUserIds: false,
		})
		expect(blocks.map(({ teamId, scope }) => [teamId, scope])).toEqual([
			['team-a', 'team'],
		])
		expect(blocks[0]!.data.members.map((row) => row.email)).toEqual([
			'u-a1@example.test',
			'u-a2@example.test',
		])
		expect(blocks[0]!.data.members[0]).not.toHaveProperty('userId')
	})

	it('gives a member of another team nothing from this team', async () => {
		const readMembers = teamsReader(teams)
		const blocks = await loadTeamProgressForViewer({
			viewerId: 'u-b1',
			managedPurchases: [],
			deps: { listOwnSeatTeamIds: async () => ['team-b'], readMembers },
		})
		expect(readMembers).not.toHaveBeenCalledWith('team-a', expect.anything())
		expect(
			blocks.flatMap(({ data }) => data.members.map((row) => row.email)),
		).toEqual(['u-b1@example.test'])
	})

	it('shows a non-owner team member only their own progress', async () => {
		const readMembers = teamsReader(teams)
		const [block, ...rest] = await loadTeamProgressForViewer({
			viewerId: 'u-a2',
			managedPurchases: [],
			deps: { listOwnSeatTeamIds: async () => ['team-a'], readMembers },
		})
		expect(rest).toEqual([])
		expect(readMembers).toHaveBeenCalledWith('team-a', {
			onlyUserId: 'u-a2',
			includeUserIds: true,
		})
		expect(block).toMatchObject({ teamId: 'team-a', scope: 'self' })
		expect(block!.data.members).toEqual([
			expect.objectContaining({ email: 'u-a2@example.test' }),
		])
		expect(block!.data.members[0]).not.toHaveProperty('userId')
		// The organization name can carry the buyer's email.
		expect(block!.data.team.organization).toBeNull()
		expect(block!.data.team.seats).toEqual({
			bought: 0,
			redeemed: 0,
			unredeemed: 0,
		})
	})

	it("drops another learner's row even if a reader ignores the scope", async () => {
		const unscoped = vi.fn(
			async (
				...[teamId, options]: Parameters<TeamProgressDeps['readMembers']>
			) => {
				const all = await teamsReader(teams)(teamId, {
					includeUserIds: options.includeUserIds,
				})
				return all
			},
		)
		const [block] = await loadTeamProgressForViewer({
			viewerId: 'u-a2',
			managedPurchases: [],
			deps: {
				listOwnSeatTeamIds: async () => ['team-a'],
				readMembers: unscoped,
			},
		})
		expect(block!.data.members.map((row) => row.email)).toEqual([
			'u-a2@example.test',
		])
	})

	it('reads a managed team once, not again as a seat', async () => {
		const readMembers = teamsReader(teams)
		const blocks = await loadTeamProgressForViewer({
			viewerId: 'u-a1',
			managedPurchases: [{ bulkCouponId: 'team-a', status: 'Valid' }],
			deps: { listOwnSeatTeamIds: async () => ['team-a'], readMembers },
		})
		expect(readMembers).toHaveBeenCalledTimes(1)
		expect(blocks.map(({ scope }) => scope)).toEqual(['team'])
	})

	it('keeps the page when one team fails, and logs ids, never emails', async () => {
		const readMembers = teamsReader(teams)
		const blocks = await loadTeamProgressForViewer({
			viewerId: 'u-owner',
			managedPurchases: [
				{ bulkCouponId: 'team-missing', status: 'Valid' },
				{ bulkCouponId: 'team-b', status: 'Valid' },
			],
			deps: { listOwnSeatTeamIds: async () => [], readMembers },
		})
		expect(blocks.map(({ teamId }) => teamId)).toEqual(['team-b'])
		expect(log.error).toHaveBeenCalledWith(
			'team.progress.read-failed',
			expect.objectContaining({ viewerId: 'u-owner', teamId: 'team-missing' }),
		)
		expect(log.info).toHaveBeenCalledWith('team.progress.read', {
			viewerId: 'u-owner',
			teams: [{ teamId: 'team-b', scope: 'team', memberCount: 1 }],
		})
		expect(JSON.stringify(log.info.mock.calls)).not.toContain('@example.test')
	})

	it('reads nothing for a viewer with no team', async () => {
		const readMembers = teamsReader(teams)
		expect(
			await loadTeamProgressForViewer({
				viewerId: 'u-solo',
				managedPurchases: [],
				deps: { listOwnSeatTeamIds: async () => [], readMembers },
			}),
		).toEqual([])
		expect(readMembers).not.toHaveBeenCalled()
		expect(log.info).not.toHaveBeenCalled()
	})
})
