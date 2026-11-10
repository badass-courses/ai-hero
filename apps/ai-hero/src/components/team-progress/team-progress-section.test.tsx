import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { expectedTeamAMembers } from '@/lib/analytics/learning-teams.fixtures'
import type { TeamProgressBlock } from '@/lib/team-progress'

import { TeamProgressSection } from './team-progress-section'

const members = expectedTeamAMembers.map(
	({ userId: _userId, ...member }) => member,
)

const managed: TeamProgressBlock = {
	teamId: 'bulk-coupon',
	scope: 'team',
	data: {
		asOf: '2026-10-29T12:00:00.000Z',
		pii: true,
		team: {
			teamId: 'bulk-coupon',
			product: { id: 'product', name: 'Synthetic Cohort' },
			seats: { bought: 5, redeemed: 3, unredeemed: 2 },
			organization: { id: 'org-a', name: 'Acme Robotics' },
		},
		members,
	},
}

const self: TeamProgressBlock = {
	teamId: 'bulk-coupon',
	scope: 'self',
	data: {
		...managed.data,
		team: {
			...managed.data.team,
			organization: null,
			seats: { bought: 0, redeemed: 0, unredeemed: 0 },
		},
		members: members.slice(0, 1),
	},
}

describe('/team progress section', () => {
	it('renders nothing without team progress', () => {
		expect(
			renderToStaticMarkup(<TeamProgressSection teamProgress={[]} />),
		).toBe('')
	})

	it('shows managers every member row and unredeemed seats as a count', () => {
		const html = renderToStaticMarkup(
			<TeamProgressSection teamProgress={[managed]} />,
		)
		expect(html).toContain('Learner progress')
		expect(html).toContain('Acme Robotics')
		expect(html).toContain('3 of 5 seats')
		expect(html).toContain('u-seat@example.test')
		expect(html).toContain('idle@example.test')
		expect(html).toContain('2 seats not redeemed yet.')
	})

	it("shows a seat holder only their own row, without the team's details", () => {
		const html = renderToStaticMarkup(
			<TeamProgressSection teamProgress={[self]} />,
		)
		expect(html).toContain('Your progress')
		expect(html).toContain('Your seat')
		expect(html).toContain('u-seat@example.test')
		expect(html).not.toContain('idle@example.test')
		expect(html).not.toContain('Acme Robotics')
		expect(html).not.toContain('seats not redeemed')
		expect(html).not.toContain('seats redeemed')
	})
})
