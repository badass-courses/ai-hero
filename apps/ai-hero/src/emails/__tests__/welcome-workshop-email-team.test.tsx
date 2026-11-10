import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it, vi } from 'vitest'

import WelcomeWorkshopEmailForTeam from '../welcome-workshop-email-team'
import WelcomeWorkshopEmailForTeamRedeemer from '../welcome-workshop-email-team-redeemer'

vi.mock('@/env.mjs', () => ({
	env: {
		COURSEBUILDER_URL: 'https://www.aihero.dev',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'support@aihero.dev',
		NEXT_PUBLIC_SITE_TITLE: 'AI Hero',
	},
}))

describe('WelcomeWorkshopEmailForTeam', () => {
	it('gives a bulk buyer the invite link and the seat rule', async () => {
		const inviteUrl = 'https://www.aihero.dev?code=bulk-abc'
		const html = await render(
			<WelcomeWorkshopEmailForTeam
				workshopTitle="Team Workshop"
				url="#start"
				inviteUrl={inviteUrl}
				quantity={7}
			/>,
		)

		expect(html).toMatchSnapshot()
		expect(html).toContain(`href="${inviteUrl}"`)
		expect(html).toContain('Each seat is for one person')
		expect(html).toContain('https://www.aihero.dev/team')
	})

	it('gives the seat claimer no invite link', async () => {
		const html = await render(
			<WelcomeWorkshopEmailForTeamRedeemer
				workshopTitle="Team Workshop"
				url="#start"
			/>,
		)

		expect(html).not.toContain('?code=')
		expect(html).not.toContain('Share this link with your team')
	})
})
