import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import {
	EditorResourceError,
	EditorResourceMutationResponseSchema,
	EditorResourceResponseSchema,
} from '@/lib/editor-resource'

const mocks = vi.hoisted(() => ({
	service: {
		get: vi.fn(),
		update: vi.fn(),
	},
	getUserAbilityForRequest: vi.fn(),
	log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/lib/editor-resource-drizzle', () => ({
	editorResourceService: mocks.service,
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({
	withSkill: <T>(handler: T) => handler,
}))

import { GET, PATCH } from './route'

const context = { params: Promise.resolve({ id: 'workshop_1' }) }
const responseResource = {
	resource: {
		id: 'workshop_1',
		type: 'workshop',
		fields: {
			title: 'Crash Course',
			slug: 'crash-course',
			state: 'draft',
			visibility: 'unlisted',
		},
		currentVersionId: null,
		createdAt: new Date('2026-08-14T00:00:00.000Z'),
		updatedAt: new Date('2026-08-14T00:00:00.000Z'),
	},
	revision: 'revision_1',
}

function request(method: 'GET' | 'PATCH', ifMatch?: string) {
	return new NextRequest(
		'http://localhost:3000/api/editor/resources/workshop_1',
		{
			method,
			headers: {
				Authorization: 'Bearer device-token',
				'Content-Type': 'application/json',
				...(ifMatch ? { 'If-Match': ifMatch } : {}),
			},
			...(method === 'PATCH'
				? { body: JSON.stringify({ action: 'save', fields: { body: 'edit' } }) }
				: {}),
		},
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getUserAbilityForRequest.mockResolvedValue({
		user: { id: 'user_editor', email: 'editor@example.com', roles: [] },
		ability: { can: vi.fn(() => false) },
		authMethod: 'device-token',
	})
	mocks.service.get.mockResolvedValue(responseResource)
	mocks.service.update.mockResolvedValue({
		...responseResource,
		resource: {
			...responseResource.resource,
			currentVersionId: 'version_2',
		},
		revision: 'revision_2',
		version: {
			id: 'version_2',
			resourceId: 'workshop_1',
			parentVersionId: 'version_1',
			versionNumber: 2,
			fields: responseResource.resource.fields,
			createdAt: new Date('2026-08-14T00:01:00.000Z'),
			createdById: 'user_editor',
		},
		baselineVersion: null,
	})
})

describe('editor resource route', () => {
	it('returns a direct resource projection with a quoted ETag', async () => {
		const response = await GET(request('GET'), context)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(response.headers.get('etag')).toBe('"revision_1"')
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(EditorResourceResponseSchema.safeParse(body).success).toBe(true)
	})

	it('rejects missing or malformed If-Match before mutation', async () => {
		for (const value of [undefined, 'revision_1', 'W/"revision_1"', '*']) {
			const response = await PATCH(request('PATCH', value), context)
			expect(response.status).toBe(428)
		}
		expect(mocks.service.update).not.toHaveBeenCalled()
	})

	it('maps a stale revision to 409', async () => {
		mocks.service.update.mockRejectedValue(
			new EditorResourceError('stale', 409, 'conflict'),
		)

		const response = await PATCH(request('PATCH', '"revision_1"'), context)
		expect(response.status).toBe(409)
		expect(await response.json()).toMatchObject({ code: 'conflict' })
	})

	it('passes the strong revision and returns the committed ETag', async () => {
		const response = await PATCH(request('PATCH', '"revision_1"'), context)
		const body = await response.json()

		expect(mocks.service.update).toHaveBeenCalledWith(
			'workshop_1',
			{ action: 'save', fields: { body: 'edit' } },
			'revision_1',
			{ userId: 'user_editor', isAdmin: false },
		)
		expect(response.headers.get('etag')).toBe('"revision_2"')
		expect(EditorResourceMutationResponseSchema.safeParse(body).success).toBe(
			true,
		)
	})
})
