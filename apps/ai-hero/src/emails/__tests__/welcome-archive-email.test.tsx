import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'

import WelcomeArchiveEmail from '../welcome-archive-email'

const workshops = [
	{
		title: 'Intro to AI',
		slug: 'intro-to-ai',
		cohortTitle: 'AI Hero Cohort 1',
	},
	{
		title: 'Prompt Engineering',
		slug: 'prompt-engineering',
		cohortTitle: 'AI Hero Cohort 1',
	},
	{
		title: 'Fine-Tuning Models',
		slug: 'fine-tuning-models',
		cohortTitle: 'AI Hero Cohort 2',
	},
]

describe('WelcomeArchiveEmail', () => {
	it('renders with workshops grouped by cohort', async () => {
		const html = await render(
			<WelcomeArchiveEmail
				productName="AI Hero Catalog Access"
				userFirstName="Alex"
				workshops={workshops}
				expiresAt={new Date(
					Date.now() + 365 * 24 * 60 * 60 * 1000,
				).toISOString()}
				cohortCount={2}
			/>,
		)

		expect(html).toContain('AI Hero Catalog Access')
		expect(html).toContain('Hey Alex,')
		expect(html).toContain('3 workshops')
		expect(html).toContain('2 past cohorts')
		expect(html).toContain('Intro to AI')
		expect(html).toContain('Prompt Engineering')
		expect(html).toContain('Fine-Tuning Models')
		expect(html).toContain('AI Hero Cohort 1')
		expect(html).toContain('AI Hero Cohort 2')
		expect(html).toContain('Browse Your Workshops')
	})

	it('renders singular cohort text for one cohort', async () => {
		const html = await render(
			<WelcomeArchiveEmail
				productName="AI Hero Catalog Access"
				workshops={[workshops[0]!]}
				expiresAt={new Date(
					Date.now() + 365 * 24 * 60 * 60 * 1000,
				).toISOString()}
				cohortCount={1}
			/>,
		)

		expect(html).toContain('1 workshop')
		expect(html).toContain('1 past cohort')
		expect(html).not.toContain('past cohorts')
	})

	it('renders fallback greeting when no name', async () => {
		const html = await render(
			<WelcomeArchiveEmail
				productName="AI Hero Catalog Access"
				workshops={workshops}
				expiresAt={new Date(
					Date.now() + 365 * 24 * 60 * 60 * 1000,
				).toISOString()}
				cohortCount={2}
			/>,
		)

		expect(html).toContain('Hi there,')
	})

	it('includes rolling unlock note', async () => {
		const html = await render(
			<WelcomeArchiveEmail
				productName="AI Hero Catalog Access"
				workshops={workshops}
				expiresAt={new Date(
					Date.now() + 365 * 24 * 60 * 60 * 1000,
				).toISOString()}
				cohortCount={2}
			/>,
		)

		expect(html).toContain('added automatically')
	})
})
