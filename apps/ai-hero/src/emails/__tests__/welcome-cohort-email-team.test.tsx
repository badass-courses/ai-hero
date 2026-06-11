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
	})
})
