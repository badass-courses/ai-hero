import { describe, expect, it } from 'vitest'

import {
	learnerCatalog,
	learnerOpenApi,
	makeLearnerAgent,
} from '../src/index.js'
import type { Learner } from '../src/index.js'
import { BASE, fakePorts, learner, type Recorder } from './fakes.js'

const TOOL_NAMES = [
	'my_courses',
	'course_outline',
	'read_lesson',
	'session_extract',
	'session_moments',
	'skill_usage',
	'search_course',
	'office_hours',
	'next_offer',
]

const rpc = (body: unknown) =>
	new Request(`${BASE}/mcp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify(body),
	})

const mcp = async (
	caller: Learner | null,
	body: unknown,
	options: Parameters<typeof fakePorts>[1] = {},
) => {
	const response = await makeLearnerAgent(fakePorts(caller, options)).handleMcp(
		rpc(body),
	)
	return {
		status: response.status,
		body: response.status === 202 ? null : await response.json(),
	}
}

describe('MCP projection', () => {
	it('negotiates a supported protocol version and falls back to the latest', async () => {
		const known = await mcp(null, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-03-26',
				capabilities: {},
				clientInfo: { name: 't', version: '1' },
			},
		})
		expect(known.body.result).toMatchObject({
			protocolVersion: '2025-03-26',
			capabilities: { tools: {}, prompts: {} },
			serverInfo: { name: 'ai-hero-learner' },
		})
		expect(known.body.result.instructions).toMatch(/my_courses/)

		const unknown = await mcp(null, {
			jsonrpc: '2.0',
			id: 2,
			method: 'initialize',
			params: { protocolVersion: '1999-01-01' },
		})
		expect(unknown.body.result.protocolVersion).toBe('2025-11-25')
	})

	it('lists every capability as a tool, in order, with its schema and honest annotations', async () => {
		const { body } = await mcp(null, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
		})
		const tools = body.result.tools as Array<Record<string, any>>
		expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES)
		const read = tools.find((tool) => tool.name === 'read_lesson')!
		expect(read.inputSchema).toMatchObject({
			type: 'object',
			required: ['lesson'],
			properties: { includeSolution: { type: 'boolean' } },
		})
		expect(read.annotations).toEqual({
			title: 'Read lesson',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		})
		expect(
			tools.find((tool) => tool.name === 'my_courses')!.inputSchema,
		).toEqual({ type: 'object', properties: {} })
	})

	it('derives tools/list from the same contracts as the catalog', async () => {
		const { body } = await mcp(null, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
		})
		const catalog = learnerCatalog()
		for (const tool of body.result.tools as Array<Record<string, any>>) {
			const entry = catalog.tools.find(
				(candidate) => candidate.name === tool.name,
			)!
			expect(tool.inputSchema).toEqual(entry.input)
			expect(tool.description).toBe(entry.description)
		}
	})

	it('answers tools/call with structured content and next_actions', async () => {
		const { body } = await mcp(learner, {
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: {
				name: 'read_lesson',
				arguments: { lesson: 'first-lesson', workshop: 'week-one' },
			},
		})
		expect(body.id).toBe(7)
		expect(body.result.isError).toBeUndefined()
		expect(body.result.structuredContent).toMatchObject({
			lesson: { slug: 'first-lesson' },
			solution: null,
			solutionAvailable: true,
		})
		expect(body.result.structuredContent.next_actions.length).toBeGreaterThan(0)
		expect(JSON.parse(body.result.content[0].text)).toEqual(
			body.result.structuredContent,
		)
	})

	it('never returns Mux ids, even when an adapter over-returns them', async () => {
		const { body } = await mcp(
			learner,
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'read_lesson', arguments: { lesson: 'first-lesson' } },
			},
			{ leakMux: true },
		)
		const text = JSON.stringify(body)
		expect(text).toContain('first-lesson')
		expect(text).not.toContain('playback-secret')
		expect(text).not.toContain('asset-secret')
		expect(text).not.toMatch(/mux/i)
	})

	it('returns an expected failure as a tool error the model can act on', async () => {
		const { body } = await mcp(null, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'my_courses', arguments: {} },
		})
		expect(body.result.isError).toBe(true)
		expect(body.result.structuredContent.error._tag).toBe('SignInRequired')
		expect(body.result.structuredContent.error.next_actions[0].href).toBe(
			`${BASE}/agents/connect`,
		)
	})

	it('reports bad arguments as a tool error and an unknown tool as invalid params', async () => {
		const bad = await mcp(learner, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'read_lesson', arguments: {} },
		})
		expect(bad.body.result.isError).toBe(true)
		expect(bad.body.result.content[0].text).toMatch(/lesson/)

		const unknown = await mcp(learner, {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: { name: 'delete_everything' },
		})
		expect(unknown.body.error.code).toBe(-32602)
	})

	it('rate limits per caller through the same dispatcher', async () => {
		const recorder: Recorder = { reads: [], rateLimitCalls: [] }
		const { body } = await mcp(
			learner,
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'read_lesson', arguments: { lesson: 'first-lesson' } },
			},
			{ limited: true, recorder },
		)
		expect(body.result.structuredContent.error).toMatchObject({
			_tag: 'RateLimited',
			retryAfterSeconds: 30,
		})
		expect(recorder.rateLimitCalls).toEqual([
			{ userId: 'user-owner', capability: 'read_lesson' },
		])
		expect(recorder.reads).toEqual([])
	})

	it('serves start_lesson with the lesson, transcript and extract, never the solution', async () => {
		const list = await mcp(learner, {
			jsonrpc: '2.0',
			id: 1,
			method: 'prompts/list',
		})
		expect(
			list.body.result.prompts.map((prompt: { name: string }) => prompt.name),
		).toEqual(['start_lesson'])

		const { body } = await mcp(learner, {
			jsonrpc: '2.0',
			id: 2,
			method: 'prompts/get',
			params: {
				name: 'start_lesson',
				arguments: { lesson: 'first-lesson', workshop: 'week-one' },
			},
		})
		const text = body.result.messages[0].content.text as string
		expect(text).toContain('Build the thing.')
		expect(text).toContain('Today we build the thing.')
		expect(text).toContain('[10s] Matt: Add a test')
		expect(text).toContain('Never reveal the solution')
		expect(text).not.toContain('Here is the answer.')
	})

	it('refuses start_lesson for an embargoed lesson with the open date', async () => {
		const { body } = await mcp(learner, {
			jsonrpc: '2.0',
			id: 1,
			method: 'prompts/get',
			params: { name: 'start_lesson', arguments: { lesson: 'locked-lesson' } },
		})
		expect(body.error.data.error).toMatchObject({
			_tag: 'NotYetOpen',
			opensAt: '2099-01-01T00:00:00.000Z',
		})
		expect(JSON.stringify(body)).not.toContain('Build the thing')
	})

	it('accepts batches, answers notifications with 202, and refuses GET', async () => {
		const batch = await mcp(null, [
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 'a', method: 'ping' },
			{ jsonrpc: '2.0', id: 'b', method: 'nope' },
		])
		expect(batch.body).toEqual([
			{ jsonrpc: '2.0', id: 'a', result: {} },
			{
				jsonrpc: '2.0',
				id: 'b',
				error: { code: -32601, message: 'Method not found: nope' },
			},
		])

		const notification = await mcp(null, {
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		})
		expect(notification.status).toBe(202)

		const get = await makeLearnerAgent(fakePorts(null)).handleMcp(
			new Request(`${BASE}/mcp`),
		)
		expect(get.status).toBe(405)

		const garbage = await makeLearnerAgent(fakePorts(null)).handleMcp(
			new Request(`${BASE}/mcp`, { method: 'POST', body: '{not json' }),
		)
		expect(garbage.status).toBe(400)
		expect((await garbage.json()).error.code).toBe(-32700)
	})

	it('maps a failing port to Unavailable, and a handler crash to a reported internal error', async () => {
		const defects: string[] = []
		const ports = fakePorts(learner)
		const agent = makeLearnerAgent({
			...ports,
			progress: { completed: () => Promise.reject(new Error('db down')) },
			entitlements: {
				...ports.entitlements,
				ownedCourses: () => {
					throw new Error('sync throw')
				},
			},
			content: {
				...ports.content,
				// Malformed adapter data: the handler trips over it.
				officeHours: async () => ({ course: 'x', sessions: null }) as never,
			},
			onDefect: (capability) => void defects.push(capability),
		})

		const outline = await agent.invoke('course_outline', {
			course: 'ai-coding',
		})
		expect(outline).toMatchObject({
			_tag: 'Failure',
			status: 503,
			error: { _tag: 'Unavailable' },
		})
		const courses = await agent.invoke('my_courses', {})
		expect(courses).toMatchObject({
			_tag: 'Failure',
			status: 503,
			error: { _tag: 'Unavailable' },
		})
		expect(defects).toEqual([])

		const crashed = makeLearnerAgent({
			...ports,
			entitlements: {
				...ports.entitlements,
				ownedCourses: async () => [{ type: 'cohort', id: 'cohort-1' }] as never,
			},
			content: {
				...ports.content,
				officeHours: async () => ({ course: 'x', sessions: null }) as never,
			},
			onDefect: (capability) => void defects.push(capability),
		})
		const response = await crashed.handleHttp(
			new Request(`${BASE}/api/learner/office_hours`),
			'office_hours',
		)
		expect(response.status).toBe(500)
		expect(JSON.stringify(await response.json())).not.toMatch(
			/sessions|null is not/,
		)
		expect(defects).toEqual(['office_hours'])
	})
})

describe('HTTP projection', () => {
	const http = (caller: Learner | null, request: Request, capability: string) =>
		makeLearnerAgent(fakePorts(caller)).handleHttp(request, capability)

	it('serves a read-only capability over GET, reading query values with their schema types', async () => {
		const response = await http(
			learner,
			new Request(
				`${BASE}/api/learner/session_extract?lesson=first-lesson&atSeconds=25&windowSeconds=10`,
			),
			'session_extract',
		)
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body).toMatchObject({
			ok: true,
			capability: 'session_extract',
			window: { atSeconds: 25 },
		})
		expect(body.next_actions.length).toBeGreaterThan(0)
		expect(response.headers.get('cache-control')).toBe('private, no-store')
	})

	it('serves POST with a JSON body', async () => {
		const response = await http(
			learner,
			new Request(`${BASE}/api/learner/course_outline`, {
				method: 'POST',
				body: JSON.stringify({ course: 'ai-coding' }),
			}),
			'course_outline',
		)
		expect(response.status).toBe(200)
		expect((await response.json()).course.slug).toBe('ai-coding')
	})

	it.each([
		['anonymous', null, 'first-lesson', 401, 'SignInRequired'],
		['embargoed', learner, 'locked-lesson', 403, 'NotYetOpen'],
		['unowned', learner, 'other-lesson', 403, 'NotEntitled'],
		['missing', learner, 'no-such-lesson', 404, 'NotFound'],
	] as const)(
		'maps a %s read to its status',
		async (_, caller, lesson, status, tag) => {
			const response = await http(
				caller,
				new Request(`${BASE}/api/learner/read_lesson?lesson=${lesson}`),
				'read_lesson',
			)
			expect(response.status).toBe(status)
			const body = await response.json()
			expect(body).toMatchObject({
				ok: false,
				capability: 'read_lesson',
				error: { _tag: tag },
			})
			expect(Array.isArray(body.next_actions)).toBe(true)
		},
	)

	it('rejects bad input with 400 and an unknown capability with 404', async () => {
		const bad = await http(
			learner,
			new Request(`${BASE}/api/learner/read_lesson`),
			'read_lesson',
		)
		expect(bad.status).toBe(400)
		const notJson = await http(
			learner,
			new Request(`${BASE}/api/learner/read_lesson`, {
				method: 'POST',
				body: '{',
			}),
			'read_lesson',
		)
		expect(notJson.status).toBe(400)
		const unknown = await http(
			learner,
			new Request(`${BASE}/api/learner/nope`, { method: 'POST' }),
			'nope',
		)
		expect(unknown.status).toBe(404)
	})

	it('sets Retry-After when rate limited', async () => {
		const response = await makeLearnerAgent(
			fakePorts(learner, { limited: true }),
		).handleHttp(new Request(`${BASE}/api/learner/my_courses`), 'my_courses')
		expect(response.status).toBe(429)
		expect(response.headers.get('retry-after')).toBe('30')
	})
})

describe('OpenAPI projection', () => {
	const document = learnerOpenApi({ basePath: '/api/learner' })

	it('has a path per capability, GET and POST for read-only ones', () => {
		expect(Object.keys(document.paths)).toEqual(
			TOOL_NAMES.map((name) => `/api/learner/${name}`),
		)
		const read = document.paths['/api/learner/read_lesson']!
		expect(Object.keys(read).sort()).toEqual(['get', 'post'])
		expect(
			(read.get as any).parameters.map(
				(p: { name: string; required: boolean }) => [p.name, p.required],
			),
		).toEqual([
			['lesson', true],
			['workshop', false],
			['includeSolution', false],
		])
	})

	it('documents each declared failure at its status, from the same failure schema', () => {
		const responses = (document.paths['/api/learner/read_lesson']!.post as any)
			.responses
		expect(Object.keys(responses).sort()).toEqual([
			'200',
			'400',
			'401',
			'403',
			'404',
			'429',
			'503',
		])
		expect(responses['403'].description).toBe('NotEntitled Or NotYetOpen.')
		const refs =
			JSON.stringify(document.paths).match(
				/#\/components\/schemas\/[A-Za-z]+/g,
			) ?? []
		for (const ref of new Set(refs)) {
			expect(document.components.schemas).toHaveProperty(ref.split('/').pop()!)
		}
	})

	it('documents the dispatcher’s 400 and 429 with the bodies it sends', async () => {
		const errorSchema = (operation: any, status: string) => {
			const schema =
				operation.responses[status].content['application/json'].schema
					.properties.error
			const name = String(schema.$ref).split('/').pop()!
			return document.components.schemas[name] as any
		}
		for (const name of TOOL_NAMES) {
			const operation = document.paths[`/api/learner/${name}`]!.post as any
			expect(errorSchema(operation, '400').properties._tag.enum).toEqual([
				'InvalidInput',
			])
			expect(errorSchema(operation, '429').properties._tag.enum).toEqual([
				'RateLimited',
			])
			expect(operation.responses['429'].headers).toHaveProperty('Retry-After')
		}

		const operation = document.paths['/api/learner/read_lesson']!.post as any
		const bad = await makeLearnerAgent(fakePorts(learner)).handleHttp(
			new Request(`${BASE}/api/learner/read_lesson`),
			'read_lesson',
		)
		const badBody = await bad.json()
		const invalid = errorSchema(operation, '400')
		expect(Object.keys(badBody.error).sort()).toEqual(
			[...invalid.required].sort(),
		)
		expect(badBody.error._tag).toBe('InvalidInput')

		const limited = await makeLearnerAgent(
			fakePorts(learner, { limited: true }),
		).handleHttp(new Request(`${BASE}/api/learner/my_courses`), 'my_courses')
		const limitedBody = await limited.json()
		const rateLimited = errorSchema(operation, '429')
		for (const key of rateLimited.required) {
			expect(limitedBody.error).toHaveProperty(key)
		}
	})

	it('uses the same input schema as the MCP tool', () => {
		const catalog = learnerCatalog()
		const body = (document.paths['/api/learner/search_course']!.post as any)
			.requestBody.content['application/json'].schema
		expect(body).toEqual(
			catalog.tools.find((tool) => tool.name === 'search_course')!.input,
		)
	})
})
