import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'

import WelcomeCohortEmailForTeam from '../welcome-cohort-email-team'

describe('WelcomeCohortEmailForTeam', () => {
	it('renders consistently', async () => {
		const html = await render(
			<WelcomeCohortEmailForTeam
				cohortTitle="Team Cohort"
				url="#start"
				quantity={5}
				availableNow={[{ slug: 'ws-1', title: 'Workshop One' }]}
				upcoming={[
					{
						date: 'April 1st, 2055',
						workshops: [{ slug: 'ws-2', title: 'Workshop Two' }],
					},
				]}
			/>,
		)

		expect(html).toMatchSnapshot()
		expect(html).toContain('Workshop One')
		expect(html).toContain('April 1st, 2055')
		expect(html).toContain('Workshop Two')
		expect(html).toContain('/team')
	})

	it('renders with no available workshops', async () => {
		const html = await render(
			<WelcomeCohortEmailForTeam
				cohortTitle="Team Cohort"
				url="#start"
				quantity={2}
			/>,
		)

		expect(html).toContain('Team Cohort')
		expect(html).toContain('/team')
		expect(html).not.toContain('?code=')
	})

	it('gives a bulk buyer the invite link and the seat rule', async () => {
		const inviteUrl = 'https://www.aihero.dev?code=bulk-abc'
		const html = await render(
			<WelcomeCohortEmailForTeam
				cohortTitle="Team Cohort"
				url="#start"
				inviteUrl={inviteUrl}
				quantity={7}
			/>,
		)

		expect(html).toMatchSnapshot()
		expect(html).toContain(`href="${inviteUrl}"`)
		expect(html).toContain('Share this link with your team')
		expect(html).toContain('Each seat is for one person')
		expect(html).toContain('/team')
	})

	it('puts the invite link in the short cohort welcome too', async () => {
		const inviteUrl = 'https://www.aihero.dev?code=bulk-abc'
		const html = await render(
			<WelcomeCohortEmailForTeam
				cohortTitle="Team Cohort"
				url="#start"
				inviteUrl={inviteUrl}
				quantity={7}
				welcomeDetails={{
					title: 'AI Coding for Real Engineers',
					schedule: "We'll email you when each part opens.",
					workshops: [],
				}}
			/>,
		)

		expect(html).toMatchSnapshot()
		expect(html).toContain(`href="${inviteUrl}"`)
		expect(html).toContain('Each seat is for one person')
		expect(html).toContain('invite a manager')
	})
})
