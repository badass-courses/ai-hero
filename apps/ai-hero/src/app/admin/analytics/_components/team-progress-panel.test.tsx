import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { expectedLearningProgress } from '@/lib/analytics/learning-progress.fixtures'
import {
	expectedTeamA,
	expectedTeamAMembers,
	expectedTeamB,
} from '@/lib/analytics/learning-teams.fixtures'
import type {
	LearningTeamMembers,
	LearningTeamProgress,
	LearningTeamSummary,
} from '@/lib/analytics/learning-teams'

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }))
import {
	sortTeams,
	TeamDetailView,
	TeamProgressPanel,
} from './team-progress-panel'

const teamA = expectedTeamA as LearningTeamSummary
const teamB = expectedTeamB as LearningTeamSummary
const teamEmpty = {
	...teamA,
	teamId: 'bulk-coupon-empty',
	members: { count: 0, signedIn: 0, neverSignedIn: 0, active7d: 0 },
	completion: { openRequiredLessons: 5, averageShare: null },
} as LearningTeamSummary

describe('team progress admin panel', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('sorts teams by any column, empty completion last', () => {
		const ids = (teams: LearningTeamSummary[]) =>
			teams.map((team) => team.teamId)
		expect(
			ids(sortTeams([teamA, teamEmpty, teamB], 'averageShare', 'desc')),
		).toEqual(['bulk-coupon-b', 'bulk-coupon', 'bulk-coupon-empty'])
		expect(
			ids(sortTeams([teamEmpty, teamB, teamA], 'averageShare', 'asc')),
		).toEqual(['bulk-coupon', 'bulk-coupon-b', 'bulk-coupon-empty'])
		expect(ids(sortTeams([teamB, teamA], 'bought', 'desc'))).toEqual([
			'bulk-coupon',
			'bulk-coupon-b',
		])
		expect(ids(sortTeams([teamA, teamB], 'purchasedAt', 'desc'))).toEqual([
			'bulk-coupon-b',
			'bulk-coupon',
		])
	})

	it('lists teams without member identities', () => {
		mocks.useQuery.mockReturnValue({
			data: {
				asOf: expectedLearningProgress.asOf,
				productId: null,
				teams: [teamA, teamB],
			},
		})
		const html = renderToStaticMarkup(
			<TeamProgressPanel
				products={[{ id: 'p', name: 'Cohort', type: 'cohort' }]}
			/>,
		)
		expect(html).toContain('2 teams')
		expect(html).toContain('All products')
		expect(html).toContain('bulk-coupon-b')
		expect(html).toContain('40%')
		expect(html).toContain('aria-sort="descending"')
		expect(html).not.toContain('example.test')
		expect(mocks.useQuery.mock.calls.at(-1)?.[0].queryKey).toEqual([
			'analytics',
			'learning/teams',
			'',
		])
	})

	it('shows a team funnel over members and member rows marked PII', () => {
		const team = {
			asOf: expectedLearningProgress.asOf,
			team: teamA,
			funnel: {
				denominator: { basis: 'team-members', count: 2 },
				rows: expectedLearningProgress.funnel.rows,
			},
			activity: expectedLearningProgress.activity,
		} as LearningTeamProgress
		const members = {
			asOf: expectedLearningProgress.asOf,
			pii: true,
			team: {
				teamId: teamA.teamId,
				product: teamA.product,
				seats: teamA.seats,
				organization: { id: 'org-a', name: 'Acme Robotics' },
			},
			members: expectedTeamAMembers,
		} as LearningTeamMembers
		const html = renderToStaticMarkup(
			<TeamDetailView team={team} members={members} />,
		)
		expect(html).toContain('out of 2 team members')
		expect(html).toContain('PII · admins only')
		expect(html).toContain('Acme Robotics')
		expect(html).toContain('u-seat@example.test')
		expect(html).toContain('Hasn&#x27;t signed in')
		// Unredeemed seats are a count, never empty member rows.
		expect(html).toContain('2 seats not redeemed yet.')
		expect(html.match(/<tr class="border-border border-t"/g)).toHaveLength(2)
	})
})
