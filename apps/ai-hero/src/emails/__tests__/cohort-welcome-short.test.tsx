import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'
import WelcomeCohortEmail from '../welcome-cohort-email'
import WelcomeCohortEmailForTeam from '../welcome-cohort-email-team'
import WelcomeCohortEmailForTeamRedeemer from '../welcome-cohort-email-team-redeemer'
import {
	buildCohortWelcomeDetails,
	cohortWelcomeSubject,
} from '@/lib/cohort-welcome-details'

const now = new Date('2026-10-08T12:00:00Z')
const fields = {
	title: 'AI Coding for Real Engineers',
	startsAt: '2026-11-09T17:00:00Z',
	endsAt: '2026-11-20T17:00:00Z',
}
const workshop = (title: string, extra = {}, resourceExtra = {}) => ({
	position: 1,
	resource: {
		type: 'workshop',
		fields: {
			title,
			slug: title.toLowerCase().replaceAll(' ', '-'),
			state: 'published',
			visibility: 'public',
			...extra,
		},
		...resourceExtra,
	},
})
const variants = [
	WelcomeCohortEmail,
	WelcomeCohortEmailForTeam,
	WelcomeCohortEmailForTeamRedeemer,
]

describe('Real Engineers welcome', () => {
	it('excludes drafts, ARCHIVE titles, private, deleted, non-workshops and not-yet-open resources', () => {
		const details = buildCohortWelcomeDetails(
			{
				fields,
				resources: [
					workshop('Open'),
					workshop('Unlisted', { visibility: 'unlisted' }),
					workshop('Draft', { state: 'draft' }),
					workshop('Old ARCHIVE'),
					workshop('archive lower case'),
					workshop('Private', { visibility: 'private' }),
					workshop('Unknown', { visibility: undefined }),
					workshop('Future', { startsAt: '2026-11-10T17:00:00Z' }),
					workshop('Invalid', { startsAt: 'bad' }),
					workshop('Deleted', {}, { deletedAt: now }),
					workshop('Post', {}, { type: 'post' }),
					{ ...workshop('Deleted link'), deletedAt: now },
				],
			},
			now,
		)
		expect(details.workshops.map((item) => item.title)).toEqual([
			'Open',
			'Unlisted',
		])
	})
	it('reads the schedule from fields and does not invent missing dates', () => {
		expect(buildCohortWelcomeDetails({ fields }, now).schedule).toBe(
			"The cohort runs November 9–20, 2026. We'll email you when each part opens.",
		)
		expect(buildCohortWelcomeDetails({ fields: {} }, now).schedule).toBe(
			"We'll email you when each part opens.",
		)
		expect(
			buildCohortWelcomeDetails(
				{
					fields: {
						...fields,
						startsAt: '2027-01-02T17:00:00Z',
						endsAt: '2027-02-03T17:00:00Z',
					},
				},
				now,
			).schedule,
		).toContain('January 2, 2027 to February 3, 2027')
	})
	for (const [index, Component] of variants.entries()) {
		it(`renders variant ${index} with empty-list fallback and entitlement-gated first step`, async () => {
			const details = buildCohortWelcomeDetails(
				{ fields, resources: [workshop('Draft ARCHIVE', { state: 'draft' })] },
				now,
			)
			const props = {
				cohortTitle: 'Cohort 005',
				url: 'https://www.aihero.dev/cohorts/test',
				quantity: 5,
				welcomeDetails: details,
			}
			const html = await render(<Component {...props} />)
			expect(html).toContain('November 9–20, 2026')
			expect(html).toContain('Reply to this email')
			expect(html).not.toContain('Draft ARCHIVE')
			expect(html).not.toContain('Cohort 005')
			expect(html).not.toContain('Open now:')
			expect(html).not.toContain('AI Coding Crash Course')
			const included = await render(
				<Component
					{...props}
					welcomeDetails={{
						...details,
						crashCourseUrl: 'https://www.aihero.dev/workshops/crash-course',
					}}
				/>,
			)
			expect(included).toContain('AI Coding Crash Course is included')
			expect(included).toContain(
				'https://www.aihero.dev/workshops/crash-course',
			)
			if (index === 1)
				expect(html.indexOf('Invite your team')).toBeLessThan(
					html.indexOf('November'),
				)
			if (index === 2) expect(html).toContain('claimed your team seat')
		})
	}
	it('uses public cohort titles in subjects', () => {
		const details = buildCohortWelcomeDetails({ fields }, now)
		expect(cohortWelcomeSubject(details, 'individual')).toBe(
			'Welcome to AI Coding for Real Engineers',
		)
		expect(cohortWelcomeSubject(details, 'team', 5)).toBe(
			'Manage your 5 AI Coding for Real Engineers seats',
		)
		expect(cohortWelcomeSubject(details, 'seat')).toBe(
			"You've claimed your seat for AI Coding for Real Engineers",
		)
	})
})
