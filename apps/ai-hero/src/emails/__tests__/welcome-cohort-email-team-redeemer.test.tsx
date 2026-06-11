import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'

import WelcomeCohortEmailForTeamRedeemer from '../welcome-cohort-email-team-redeemer'

describe('WelcomeCohortEmailForTeamRedeemer', () => {
	it('renders consistently', async () => {
		const html = await render(
			<WelcomeCohortEmailForTeamRedeemer
				cohortTitle="Redeemer Cohort"
				url="#start"
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
		expect(html).toContain('claimed your seat via your team')
	})

	it('renders with no available workshops', async () => {
		const html = await render(
			<WelcomeCohortEmailForTeamRedeemer
				cohortTitle="Redeemer Cohort"
				url="#start"
			/>,
		)

		expect(html).toContain('Redeemer Cohort')
		expect(html).toContain('claimed your seat via your team')
	})
})
