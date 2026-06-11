import * as React from 'react'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'

import { WorkshopAccessEmail } from '../workshop-access-email'

describe('WorkshopAccessEmail', () => {
	it('renders consistently', async () => {
		const html = await render(
			<WorkshopAccessEmail
				user={{ name: 'Vojta', email: 'vojta@test.com' }}
				workshop={{
					fields: {
						title: 'Claude Code Fundamentals',
						description: 'Learn the basics',
						startsAt: '2026-03-30T07:01:00.000Z',
						slug: 'claude-code-fundamentals',
					},
				}}
				emailContent={{
					fields: {
						title: 'Your access to Claude Code Fundamentals opens today',
					},
				}}
			/>,
		)

		expect(html).toMatchSnapshot()
		expect(html).toContain('Claude Code Fundamentals')
		expect(html).toContain('Start Learning')
		expect(html).toContain('/workshops/claude-code-fundamentals')
	})

	it('renders with custom body markdown', async () => {
		const html = await render(
			<WorkshopAccessEmail
				user={{ name: 'Vojta', email: 'vojta@test.com' }}
				workshop={{
					fields: {
						title: 'Claude Code Fundamentals',
						slug: 'claude-code-fundamentals',
					},
				}}
				emailContent={{
					fields: {
						title: 'Your access opens today',
						body: '**Bonus:** Check out the Discord channel.',
					},
				}}
			/>,
		)

		expect(html).toContain('Bonus:')
		expect(html).toContain('Discord channel')
	})

	it('renders fallback greeting when no user name', async () => {
		const html = await render(
			<WorkshopAccessEmail
				user={{ email: 'anon@test.com' }}
				workshop={{
					fields: {
						title: 'Claude Code Fundamentals',
						slug: 'claude-code-fundamentals',
					},
				}}
				emailContent={{
					fields: { title: 'Access opens today' },
				}}
			/>,
		)

		expect(html).not.toContain('Vojta')
		expect(html).toContain('there')
	})
})
