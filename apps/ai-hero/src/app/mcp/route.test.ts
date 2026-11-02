import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ portsFor: vi.fn(), resolveBearer: vi.fn() }))

vi.mock('@/lib/learner-agent/ports', () => ({
	learnerAgentPortsFor: mocks.portsFor,
}))
vi.mock('@/lib/learner-agent/identity', () => ({
	resolveBearer: mocks.resolveBearer,
	LEARNER_READ_SCOPE: 'learner:read',
	LEARNER_TOKEN_TTL_MS: 90 * 24 * 60 * 60 * 1000,
}))

import { GET, POST } from './route'

const BASE = 'https://aihero.test'
const METADATA =
	'http://localhost:3000/.well-known/oauth-protected-resource/mcp'

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

const rpc = (body: unknown, authorization?: string) =>
	POST(
		new Request(`${BASE}/mcp`, {
			method: 'POST',
			headers: authorization ? { Authorization: authorization } : {},
			body: JSON.stringify(body),
		}),
	)

const call = (name: string, args: unknown = {}) => ({
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name, arguments: args },
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.resolveBearer.mockResolvedValue({ kind: 'anonymous' })
	mocks.portsFor.mockImplementation(async (_request, learner) => ({
		...ports,
		learner,
	}))
})

describe('/mcp', () => {
	it('lists the learner tools through the package projection', async () => {
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
			'session_moments',
			'skill_usage',
			'search_course',
			'office_hours',
			'next_offer',
		])
	})

	it('serves public tools to an anonymous caller with no challenge', async () => {
		const response = await rpc(call('search_course', { query: 'agents' }))
		expect(response.status).toBe(200)
		expect(response.headers.get('www-authenticate')).toBeNull()
	})

	it('answers an anonymous learner-only call with 401 and the resource metadata', async () => {
		const response = await rpc(call('my_courses'))
		expect(response.status).toBe(401)
		expect(response.headers.get('www-authenticate')).toBe(
			`Bearer resource_metadata="${METADATA}", scope="learner:read"`,
		)
		const body = await response.json()
		expect(body.result.structuredContent.error).toMatchObject({
			_tag: 'SignInRequired',
		})
		expect(body.result.structuredContent.error.next_actions[0].href).toBe(
			`${BASE}/api/learner#sign-in`,
		)
	})

	it('answers an invalid, expired or revoked token with 401, never the public subset', async () => {
		mocks.resolveBearer.mockResolvedValue({ kind: 'invalid' })
		const response = await rpc(
			call('search_course', { query: 'agents' }),
			'Bearer revoked-token',
		)
		expect(response.status).toBe(401)
		expect(response.headers.get('www-authenticate')).toContain(
			`resource_metadata="${METADATA}"`,
		)
		expect(response.headers.get('www-authenticate')).toContain(
			'error="invalid_token"',
		)
		expect(mocks.portsFor).not.toHaveBeenCalled()
	})

	it('passes a signed-in learner through without a challenge', async () => {
		const learner = { userId: 'u1', tokenKind: 'learner-token' }
		mocks.resolveBearer.mockResolvedValue({ kind: 'learner', learner })
		const response = await rpc(
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			'Bearer good-token',
		)
		expect(response.status).toBe(200)
		expect(mocks.portsFor).toHaveBeenCalledWith(expect.any(Request), learner)
	})

	it('refuses GET: there is no server-to-client stream', async () => {
		expect((await GET()).status).toBe(405)
	})
})
