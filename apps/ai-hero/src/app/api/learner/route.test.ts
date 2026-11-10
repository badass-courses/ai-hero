import { describe, expect, it } from 'vitest'

import { GET } from './route'

describe('/api/learner guide', () => {
	it('serves the agent guide as markdown, naming the MCP URL, sign-in and companion rules', async () => {
		const response = await GET(new Request('https://aihero.test/api/learner'))
		expect(response.headers.get('content-type')).toContain('text/markdown')
		const text = await response.text()
		expect(text).toContain('/mcp')
		expect(text).toContain('scope=learner:read')
		expect(text).toContain('Never reveal the solution')
		expect(text).toContain('`read_lesson`')
		expect(text).not.toMatch(/\u2014/)
	})

	it('serves the tool catalog as JSON on request', async () => {
		const response = await GET(
			new Request('https://aihero.test/api/learner', {
				headers: { Accept: 'application/json' },
			}),
		)
		const body = await response.json()
		expect(body.tools.map((tool: { name: string }) => tool.name)).toContain(
			'read_lesson',
		)
		expect(body.prompts.map((prompt: { name: string }) => prompt.name)).toEqual(
			['start_lesson'],
		)
	})
})
