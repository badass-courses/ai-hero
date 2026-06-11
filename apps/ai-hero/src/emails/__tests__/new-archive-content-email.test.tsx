import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'

import NewArchiveContentEmail from '../new-archive-content-email'

const workshops = [
	{ title: 'RAG Basics', slug: 'rag-basics', cohortTitle: 'AI Hero Cohort 3' },
	{
		title: 'Agent Patterns',
		slug: 'agent-patterns',
		cohortTitle: 'AI Hero Cohort 3',
	},
]

describe('NewArchiveContentEmail', () => {
	it('renders new content notification', async () => {
		const html = await render(
			<NewArchiveContentEmail
				productName="AI Hero Catalog Access"
				userFirstName="Alex"
				workshops={workshops}
				cohortCount={1}
				expiresAt={new Date(
					Date.now() + 300 * 24 * 60 * 60 * 1000,
				).toISOString()}
			/>,
		)

		expect(html).toContain('New Content Available')
		expect(html).toContain('Hey Alex,')
		expect(html).toContain('1 past cohort')
		expect(html).toContain('RAG Basics')
		expect(html).toContain('Agent Patterns')
		expect(html).toContain('AI Hero Cohort 3')
		expect(html).toContain('Start Learning')
		expect(html).toContain('More content will be added automatically')
	})

	it('renders plural cohort text', async () => {
		const html = await render(
			<NewArchiveContentEmail
				productName="AI Hero Catalog Access"
				workshops={[
					...workshops,
					{
						title: 'Embeddings',
						slug: 'embeddings',
						cohortTitle: 'AI Hero Cohort 4',
					},
				]}
				cohortCount={2}
				expiresAt={new Date(
					Date.now() + 300 * 24 * 60 * 60 * 1000,
				).toISOString()}
			/>,
		)

		expect(html).toContain('2 past cohorts')
	})

	it('renders fallback greeting when no name', async () => {
		const html = await render(
			<NewArchiveContentEmail
				productName="AI Hero Catalog Access"
				workshops={workshops}
				cohortCount={1}
				expiresAt={new Date(
					Date.now() + 300 * 24 * 60 * 60 * 1000,
				).toISOString()}
			/>,
		)

		expect(html).toContain('Hi there,')
	})
})
