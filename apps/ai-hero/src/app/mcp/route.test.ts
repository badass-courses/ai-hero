import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ portsFor: vi.fn() }))

vi.mock('@/lib/learner-agent/ports', () => ({
	learnerAgentPortsFor: mocks.portsFor,
}))

import { GET, POST } from './route'

const BASE = 'https://aihero.test'

const ports = {
	learner: null,
	entitlements: {} as never,
	content: {} as never,
	progress: {} as never,
	search: { search: async () => [] },
	audit: { read: () => undefined },
	rateLimit: { consume: async () => ({ ok: true }) as const },
	site: {
		baseUrl: BASE,
		connectUrl: `${BASE}/api/learner#sign-in`,
		instructionsUrl: `${BASE}/api/learner`,
		mcpUrl: `${BASE}/mcp`,
	},
}

const rpc = (body: unknown) =>
	POST(
		new Request(`${BASE}/mcp`, { method: 'POST', body: JSON.stringify(body) }),
	)

describe('/mcp', () => {
	it('lists the cut-1 tools through the package projection', async () => {
		mocks.portsFor.mockResolvedValue(ports)
		const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(
			body.result.tools.map((tool: { name: string }) => tool.name),
		).toEqual([
			'my_courses',
			'course_outline',
			'read_lesson',
			'session_extract',
			'search_course',
			'office_hours',
		])
	})

	it('asks an anonymous caller to sign in, pointing at the guide', async () => {
		mocks.portsFor.mockResolvedValue(ports)
		const response = await rpc({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'my_courses' },
		})
		const body = await response.json()
		expect(body.result.isError).toBe(true)
		expect(body.result.structuredContent.error).toMatchObject({
			_tag: 'SignInRequired',
		})
		expect(body.result.structuredContent.error.next_actions[0].href).toBe(
			`${BASE}/api/learner#sign-in`,
		)
	})

	it('refuses GET: there is no server-to-client stream', async () => {
		expect((await GET()).status).toBe(405)
	})
})
