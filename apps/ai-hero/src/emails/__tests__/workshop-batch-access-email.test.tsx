import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'

import { WorkshopBatchAccessEmail } from '../workshop-batch-access-email'

describe('WorkshopBatchAccessEmail', () => {
	const workshops = [
		{
			fields: {
				title: 'Feedback Loops',
				description: 'Build feedback loops into your workflow',
				slug: 'day-4-feedback-loops-fcqu2',
			},
		},
		{
			fields: {
				title: 'Ralph',
				description: 'Run Claude Code autonomously with Ralph loops',
				slug: 'day-5-ralph-dj2dh',
			},
		},
		{
			fields: {
				title: 'Human in the Loop Patterns',
				description: 'Apply taste to your agentic workflow',
				slug: 'day-6-taste-kgy4d',
			},
		},
	]

	it('renders consistently', async () => {
		const html = await render(
			<WorkshopBatchAccessEmail
				user={{ name: 'Vojta', email: 'vojta@test.com' }}
				workshops={workshops}
			/>,
		)

		expect(html).toMatchSnapshot()
		expect(html).toContain('3 new workshops')
		expect(html).toContain('Feedback Loops')
		expect(html).toContain('Ralph')
		expect(html).toContain('Human in the Loop Patterns')
	})

	it('renders workshop links', async () => {
		const html = await render(
			<WorkshopBatchAccessEmail
				user={{ name: 'Vojta', email: 'vojta@test.com' }}
				workshops={workshops}
			/>,
		)

		expect(html).toContain('/workshops/day-4-feedback-loops-fcqu2')
		expect(html).toContain('/workshops/day-5-ralph-dj2dh')
		expect(html).toContain('/workshops/day-6-taste-kgy4d')
	})

	it('renders fallback greeting when no user name', async () => {
		const html = await render(
			<WorkshopBatchAccessEmail
				user={{ email: 'anon@test.com' }}
				workshops={workshops}
			/>,
		)

		expect(html).not.toContain('Vojta')
		expect(html).toContain('there')
	})

	it('renders singular text for single workshop', async () => {
		const html = await render(
			<WorkshopBatchAccessEmail
				user={{ name: 'Vojta', email: 'vojta@test.com' }}
				workshops={[workshops[0]!]}
			/>,
		)

		expect(html).toContain('1 new workshop')
		expect(html).not.toContain('workshops are')
	})
})
