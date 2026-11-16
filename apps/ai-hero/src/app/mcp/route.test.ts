import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	portsFor: vi.fn(),
	resolveBearer: vi.fn(),
	stage: vi.fn(),
}))

vi.mock('@/lib/learner-agent/retirement.server', () => ({
	readLearnerAgentStage: mocks.stage,
}))

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
	mocks.stage.mockResolvedValue('active')
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
		expect((await response.json()).error.message).toBe(
			'Your AI Hero login expired. Run `aihero-cli auth login` (or reconnect the MCP) to sign in again.',
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

describe('/mcp retirement', () => {
	it('retired: answers a tool call with the message and lesson link, before any token check', async () => {
		mocks.stage.mockResolvedValue('retired')
		mocks.resolveBearer.mockResolvedValue({ kind: 'invalid' })
		const response = await rpc(
			call('read_lesson', { workshop: 'feedback-loops', lesson: 'intro' }),
			'Bearer revoked-token',
		)
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.id).toBe(1)
		expect(body.result.isError).toBe(true)
		expect(body.result.content[0].text).toContain('retired')
		expect(body.result.content[0].text).toContain(
			'/workshops/feedback-loops/intro',
		)
		expect(mocks.resolveBearer).not.toHaveBeenCalled()
	})

	it('retired: still answers tools/list, so the client keeps working', async () => {
		mocks.stage.mockResolvedValue('retired')
		const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(Array.isArray(body.result.tools)).toBe(true)
	})

	it('retired: a batch keeps both answers, in one response', async () => {
		mocks.stage.mockResolvedValue('retired')
		const response = await rpc([
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			{ ...call('my_courses'), id: 2 },
		])
		const body = await response.json()
		expect(Array.isArray(body)).toBe(true)
		expect(body.map((m: { id: number }) => m.id).sort()).toEqual([1, 2])
		expect(body.find((m: { id: number }) => m.id === 2).result.isError).toBe(
			true,
		)
	})

	it('notice: the live result carries the notice as a last content item', async () => {
		mocks.stage.mockResolvedValue('notice')
		const response = await rpc(call('search_course', { query: 'tdd' }))
		expect(response.status).toBe(200)
		const body = await response.json()
		const texts = body.result.content.map((c: { text: string }) => c.text)
		expect(texts.at(-1)).toContain('retiring this connection')
		expect(texts.length).toBeGreaterThan(1)
	})

	it('active: results carry no notice', async () => {
		const response = await rpc(call('search_course', { query: 'tdd' }))
		const body = await response.json()
		const texts = body.result.content.map((c: { text: string }) => c.text)
		expect(texts.join(' ')).not.toContain('retiring this connection')
	})
})
