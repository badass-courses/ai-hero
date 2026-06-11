import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'

import WelcomeCohortEmail from '../welcome-cohort-email'

const availableWorkshops = [
	{ title: 'Intro to AI', slug: 'intro-to-ai' },
	{ title: 'Prompt Engineering', slug: 'prompt-engineering' },
	{ title: 'Fine-Tuning Models', slug: 'fine-tuning-models' },
]

const upcomingGroups = [
	{
		date: 'April 1st, 2055',
		workshops: [{ title: 'Advanced Agents', slug: 'advanced-agents' }],
	},
]

describe('WelcomeCohortEmail', () => {
	it('renders with available and upcoming workshops', async () => {
		const html = await render(
			<WelcomeCohortEmail
				cohortTitle="AI Hero Cohort"
				url="https://aihero.dev/cohorts/ai-hero"
				userFirstName="Alex"
				availableNow={availableWorkshops}
				upcoming={upcomingGroups}
			/>,
		)

		expect(html).toMatchSnapshot()
		expect(html).toContain('right now')
		expect(html).toContain('Intro to AI')
		expect(html).toContain('Prompt Engineering')
		expect(html).toContain('Fine-Tuning Models')
		expect(html).toContain('April 1st, 2055')
		expect(html).toContain('Advanced Agents')
	})

	it('renders with no workshops available yet', async () => {
		const html = await render(
			<WelcomeCohortEmail
				cohortTitle="AI Hero Cohort"
				url="https://aihero.dev/cohorts/ai-hero"
				userFirstName="Alex"
				upcoming={upcomingGroups}
			/>,
		)

		expect(html).toContain('when the first')
		expect(html).not.toContain('right now')
	})

	it('renders with all workshops available', async () => {
		const html = await render(
			<WelcomeCohortEmail
				cohortTitle="AI Hero Cohort"
				url="https://aihero.dev/cohorts/ai-hero"
				availableNow={availableWorkshops}
			/>,
		)

		expect(html).toContain('right now')
		expect(html).not.toContain('Opening')
	})

	it('renders fallback greeting when no name', async () => {
		const html = await render(
			<WelcomeCohortEmail
				cohortTitle="AI Hero Cohort"
				url="https://aihero.dev/cohorts/ai-hero"
			/>,
		)

		expect(html).toContain('there')
	})
})
