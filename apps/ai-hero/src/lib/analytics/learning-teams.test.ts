import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({}))

import type { LearningStructure } from './learning-progress'
import {
	formatLearningTeamMember,
	formatLearningTeamSummary,
	openRequiredLessonIds,
	utcWallClock,
	type LearningTeamRow,
} from './learning-teams'

const team: LearningTeamRow = {
	teamId: 'bulk-coupon',
	productId: 'product',
	productName: 'Synthetic',
	purchaseIds: 'p-1,p-2',
	purchasedAtMs: '1790000000000.000',
	maxUses: 5,
	usedCount: 7,
	organizationId: 'org-a',
	organizationName: "buyer@example.test's Team",
}

describe('learning team formatting', () => {
	it('never reports negative unredeemed seats or organization names', () => {
		const summary = formatLearningTeamSummary(
			team,
			{
				teamId: 'bulk-coupon',
				members: '2',
				signedIn: '1',
				active7d: 0,
				openCompleted: '5',
			},
			5,
		)
		expect(summary.seats).toEqual({ bought: 5, redeemed: 7, unredeemed: 0 })
		expect(summary.purchaseIds).toEqual(['p-1', 'p-2'])
		expect(summary.purchasedAt).toBe(new Date(1790000000000).toISOString())
		expect(summary.completion).toEqual({
			openRequiredLessons: 5,
			averageShare: 0.5,
		})
		expect(JSON.stringify(summary)).not.toContain('example.test')
	})

	it('reports no completion share without members or open lessons', () => {
		expect(
			formatLearningTeamSummary(team, undefined, 5).completion.averageShare,
		).toBeNull()
		expect(
			formatLearningTeamSummary(
				team,
				{
					teamId: 'bulk-coupon',
					members: 2,
					signedIn: 2,
					active7d: 2,
					openCompleted: 0,
				},
				0,
			).completion.averageShare,
		).toBeNull()
	})

	it('refuses member counts that do not reconcile', () => {
		expect(() =>
			formatLearningTeamSummary(
				team,
				{
					teamId: 'bulk-coupon',
					members: 1,
					signedIn: 2,
					active7d: 0,
					openCompleted: 0,
				},
				5,
			),
		).toThrow('do not reconcile')
		expect(() =>
			formatLearningTeamSummary(
				team,
				{
					teamId: 'bulk-coupon',
					members: 1,
					signedIn: 1,
					active7d: 0,
					openCompleted: 6,
				},
				5,
			),
		).toThrow('do not reconcile')
		expect(() =>
			formatLearningTeamSummary({ ...team, maxUses: null }, undefined, 5),
		).toThrow('invalid seat count')
	})

	it('reads progress DATETIMEs as UTC wall-clock time', () => {
		expect(utcWallClock('2026-10-29 04:00:00')).toBe('2026-10-29T04:00:00.000Z')
		expect(utcWallClock(null)).toBeNull()
		expect(() => utcWallClock(new Date())).toThrow('invalid timestamp')
	})

	it('includes member user ids only when asked', () => {
		const row = {
			userId: 'u-1',
			email: 'u-1@example.test',
			name: null,
			redeemedAtMs: 1790000000000,
			signedIn: 1,
			lastActiveAt: null,
			lessonsCompleted: '3',
			workshopsStarted: 2,
			workshopsCompleted: 1,
		}
		expect(formatLearningTeamMember(row, 4, false)).not.toHaveProperty('userId')
		expect(formatLearningTeamMember(row, 4, true)).toMatchObject({
			userId: 'u-1',
			signedIn: true,
			workshops: { started: 2, completed: 1, total: 4 },
		})
		expect(() =>
			formatLearningTeamMember({ ...row, workshopsStarted: 5 }, 4, false),
		).toThrow('do not reconcile')
	})

	it('counts only open workshops toward completion', () => {
		const structure = {
			lessonIds: ['l-1', 'l-2', 'l-3'],
			nodes: [
				{
					id: 'w-open',
					kind: 'workshop',
					availability: { status: 'available' },
					lessonIds: ['l-1', 'l-2'],
				},
				{
					id: 's-open',
					kind: 'section',
					availability: { status: 'available' },
					lessonIds: ['l-2'],
				},
				{
					id: 'w-locked',
					kind: 'workshop',
					availability: { status: 'locked', reason: 'scheduled' },
					lessonIds: ['l-3'],
				},
			],
		} as unknown as LearningStructure
		expect(openRequiredLessonIds(structure)).toEqual(['l-1', 'l-2'])
	})
})
