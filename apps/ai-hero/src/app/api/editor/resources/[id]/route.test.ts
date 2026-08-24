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
		rollback: vi.fn(),
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

import { POST as ROLLBACK } from './rollback/route'
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

function request(
	method: 'GET' | 'PATCH',
	expectedRevision?: string,
	ifMatch?: string,
) {
	return new NextRequest(
		'http://localhost:3000/api/editor/resources/workshop_1',
		{
			method,
			headers: {
				Authorization: 'Bearer device-token',
				'Content-Type': 'application/json',
				...(expectedRevision
					? { 'X-AIH-Expected-Revision': expectedRevision }
					: {}),
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
	const mutationResponse = {
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
		effects: { typesense: 'queued', cache: 'completed' },
		warnings: [],
	}
	mocks.service.update.mockResolvedValue(mutationResponse)
	mocks.service.rollback.mockResolvedValue(mutationResponse)
})

describe('editor resource route', () => {
	it('returns the resource revision through the custom header and JSON', async () => {
		const response = await GET(request('GET'), context)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(response.headers.get('x-aih-resource-revision')).toBe('revision_1')
		expect(response.headers.get('etag')).toBeNull()
		expect(response.headers.get('access-control-expose-headers')).toBe(
			'X-AIH-Resource-Revision',
		)
		expect(response.headers.get('access-control-allow-headers')).toContain(
			'X-AIH-Expected-Revision',
		)
		expect(response.headers.get('access-control-allow-headers')).not.toContain(
			'If-Match',
		)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(body.revision).toBe('revision_1')
		expect(EditorResourceResponseSchema.safeParse(body).success).toBe(true)
	})

	it('requires the custom expected revision even when If-Match is present', async () => {
		const response = await PATCH(
			request('PATCH', undefined, '"revision_1"'),
			context,
		)
		expect(response.status).toBe(428)
		expect(mocks.service.update).not.toHaveBeenCalled()
	})

	it('returns 400 for malformed mutation and rollback JSON', async () => {
		const malformed = (url: string, method: 'PATCH' | 'POST') =>
			new NextRequest(url, {
				method,
				headers: {
					Authorization: 'Bearer device-token',
					'Content-Type': 'application/json',
					'X-AIH-Expected-Revision': 'revision_1',
				},
				body: '{"broken":',
			})

		const update = await PATCH(
			malformed(
				'http://localhost:3000/api/editor/resources/workshop_1',
				'PATCH',
			),
			context,
		)
		const rollback = await ROLLBACK(
			malformed(
				'http://localhost:3000/api/editor/resources/workshop_1/rollback',
				'POST',
			),
			context,
		)

		expect(update.status).toBe(400)
		expect(rollback.status).toBe(400)
		expect(await update.json()).toMatchObject({ code: 'invalid-input' })
		expect(await rollback.json()).toMatchObject({ code: 'invalid-input' })
		expect(mocks.service.update).not.toHaveBeenCalled()
		expect(mocks.service.rollback).not.toHaveBeenCalled()
	})

	it('maps a stale revision to 409', async () => {
		mocks.service.update.mockRejectedValue(
			new EditorResourceError('stale', 409, 'conflict'),
		)

		const response = await PATCH(request('PATCH', 'revision_1'), context)
		expect(response.status).toBe(409)
		expect(await response.json()).toMatchObject({ code: 'conflict' })
	})

	it('uses the custom revision header for rollback', async () => {
		const response = await ROLLBACK(
			new NextRequest(
				'http://localhost:3000/api/editor/resources/workshop_1/rollback',
				{
					method: 'POST',
					headers: {
						Authorization: 'Bearer device-token',
						'Content-Type': 'application/json',
						'X-AIH-Expected-Revision': 'revision_1',
					},
					body: JSON.stringify({ versionId: 'version_1' }),
				},
			),
			context,
		)

		expect(mocks.service.rollback).toHaveBeenCalledWith(
			'workshop_1',
			'version_1',
			'revision_1',
			expect.objectContaining({ userId: 'user_editor' }),
		)
		expect(response.headers.get('x-aih-resource-revision')).toBe('revision_2')
	})

	it('uses custom revision headers with no If-Match dependency', async () => {
		const patchRequest = request('PATCH', 'revision_1')
		expect(patchRequest.headers.has('if-match')).toBe(false)
		const response = await PATCH(patchRequest, context)
		const body = await response.json()

		expect(mocks.service.update).toHaveBeenCalledWith(
			'workshop_1',
			{ action: 'save', fields: { body: 'edit' } },
			'revision_1',
			expect.objectContaining({ userId: 'user_editor', isAdmin: false }),
		)
		expect(response.headers.get('x-aih-resource-revision')).toBe('revision_2')
		expect(response.headers.get('etag')).toBeNull()
		expect(body.revision).toBe('revision_2')
		expect(EditorResourceMutationResponseSchema.safeParse(body).success).toBe(
			true,
		)
	})
})
