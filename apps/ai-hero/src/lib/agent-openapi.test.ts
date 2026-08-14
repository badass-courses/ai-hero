import SwaggerParser from '@apidevtools/swagger-parser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zodToJsonSchema } from 'zod-to-json-schema'

import { TagListResponseSchema } from './agent-api-contracts'
import { buildAgentOpenApiDocument } from './agent-openapi'

const mocks = vi.hoisted(() => ({
	getTags: vi.fn(),
	createTag: vi.fn(),
}))

vi.mock('@/lib/tags-query', () => mocks)
vi.mock('@/server/with-skill', () => ({
	withSkill: <T>(handler: T) => handler,
}))

import { GET as getTags } from '@/app/api/(content)/tags/route'

beforeEach(() => {
	mocks.getTags.mockReset()
	mocks.createTag.mockReset()
})

describe('agent OpenAPI contract', () => {
	it('validates as OpenAPI 3.1 and resolves every local reference', async () => {
		const document = buildAgentOpenApiDocument('http://localhost:3000')

		await expect(
			SwaggerParser.validate(structuredClone(document) as any),
		).resolves.toBeTruthy()
		expect(document.openapi).toBe('3.1.0')
		expect(document.jsonSchemaDialect).toBe(
			'https://json-schema.org/draft/2019-09/schema',
		)
	})

	it('documents the exact PAT write-scope gates', () => {
		const document = buildAgentOpenApiDocument('http://localhost:3000')
		const operationScopes = [
			[
				document.paths['/api/lessons'].put,
				['content:write', 'content:publish', 'content:relations'],
			],
			[
				document.paths['/api/posts'].post,
				['content:write', 'content:relations'],
			],
			[
				document.paths['/api/posts'].put,
				['content:write', 'content:publish', 'content:relations'],
			],
			[
				document.paths['/api/skills/changelog'].post,
				['content:write', 'content:publish', 'content:relations'],
			],
			[document.paths['/api/uploads/multipart/create'].post, ['media:upload']],
			[document.paths['/api/uploads/multipart/part-url'].get, ['media:upload']],
			[
				document.paths['/api/uploads/multipart/complete'].post,
				['media:upload'],
			],
			[
				document.paths['/api/uploads/new'].post,
				['media:upload', 'content:relations'],
			],
			[document.paths['/api/shortlinks'].get, ['shortlinks:manage']],
			[document.paths['/api/shortlinks'].post, ['shortlinks:manage']],
			[document.paths['/api/shortlinks'].patch, ['shortlinks:manage']],
			[document.paths['/api/shortlinks'].delete, ['shortlinks:manage']],
			[document.paths['/api/tags'].post, ['content:relations']],
			[document.paths['/api/tags/attach'].post, ['content:relations']],
			[document.paths['/api/tags/attach'].delete, ['content:relations']],
			[document.paths['/api/pages'].put, ['content:write', 'content:publish']],
		] as const

		for (const [operation, scopes] of operationScopes) {
			expect(operation['x-required-scopes']).toEqual(scopes)
			expect(operation['x-scope-requirements']).toContain('PAT:')
			expect(operation['x-agent-token-policy']).not.toContain('are excluded')
		}

		expect(document.info.description).toContain('content:write')
		expect(document.info.description).toContain('x-scope-requirements')
		expect(document.paths['/api/posts'].put.description).toContain(
			'only updates an existing draft',
		)
		expect(
			document.paths['/api/uploads/new'].post['x-scope-requirements'],
		).toContain('both required')
		expect(document.paths['/api/uploads/signed-url'].get).toMatchObject({
			'x-required-scopes': [],
			'x-agent-token-policy': expect.stringContaining('are excluded'),
		})
		const writeResponses = document.paths['/api/posts'].post
			.responses as Record<string, { description: string }>
		expect(writeResponses['403']?.description).toContain(
			'content:write against published content',
		)
		expect(writeResponses['403']?.description).toContain(
			'content:read never authorizes writes',
		)
	})

	it('classifies resource-bound editor operations truthfully', () => {
		const document = buildAgentOpenApiDocument('http://localhost:3000')
		const list = document.paths['/api/editor/resources'].get
		const read = document.paths['/api/editor/resources/{id}'].get
		const update = document.paths['/api/editor/resources/{id}'].patch
		const versions = document.paths['/api/editor/resources/{id}/versions'].get
		const rollback = document.paths['/api/editor/resources/{id}/rollback'].post

		for (const operation of [list, read, versions]) {
			expect(operation).toMatchObject({
				'x-read-only': true,
				'x-destructive': false,
				'x-required-scopes': [],
			})
		}
		for (const operation of [update, rollback]) {
			expect(operation).toMatchObject({
				'x-read-only': false,
				'x-destructive': true,
				'x-required-scopes': [],
			})
			expect(operation.parameters).toContainEqual(
				expect.objectContaining({ name: 'If-Match', required: true }),
			)
			expect(operation.responses).toHaveProperty('409')
			expect(operation.responses).toHaveProperty('428')
		}

		for (const operation of [read, update, rollback]) {
			expect(operation.responses['200']).toHaveProperty('headers.ETag')
		}

		expect(update['x-resource-authorization']).toContain(
			'active ContentContribution',
		)
		expect(update['x-resource-authorization']).toContain(
			'createdById alone grants nothing',
		)
		expect(update['x-agent-token-policy']).toContain(
			'active AI Hero DeviceAccessToken',
		)
		expect(update['x-agent-token-policy']).toContain(
			'analytics-issued DeviceAccessToken',
		)
		expect(update['x-agent-token-policy']).toContain(
			'aih_pat_* tokens are excluded',
		)
		expect(update['x-idempotency']).toContain('not idempotent')
		expect(update['x-idempotency']).toContain('GET the resource')
		expect(update.description).toContain('slug is immutable')
		expect(rollback.description).toContain(
			'published resource remains published',
		)
		expect(rollback.description).toContain('never rewritten')
		expect(
			document.components.schemas.EditorResourceMutationResponse.properties,
		).toHaveProperty('warnings')
	})

	it('documents changelog compatibility fields as deprecated', () => {
		const document = buildAgentOpenApiDocument('http://localhost:3000')
		const schema = document.components.schemas.SkillChangelogSuccessResponse
		const compatibilityShape = schema.allOf[1]

		expect(schema.description).toContain('canonical command envelope')
		expect(compatibilityShape.required).toEqual(['id', 'slug'])
		expect(compatibilityShape.properties.id).toMatchObject({
			type: 'string',
			deprecated: true,
		})
		expect(compatibilityShape.properties.slug).toMatchObject({
			type: 'string',
			deprecated: true,
		})
	})

	it('matches the documented tag-list schema with a real route response', async () => {
		mocks.getTags.mockResolvedValue([
			{
				id: 'tag_1',
				type: 'topic',
				organizationId: null,
				fields: {
					name: 'agents',
					label: 'Agents',
					description: null,
					slug: 'agents',
					image_url: null,
					contexts: ['content'],
					url: null,
					popularity_order: 1,
				},
				createdAt: new Date('2026-08-03T12:00:00.000Z'),
				updatedAt: new Date('2026-08-03T12:00:00.000Z'),
				deleteAt: null,
			},
		])

		const routeResponse = await getTags(undefined as never)
		const payload = await routeResponse.json()
		const document = buildAgentOpenApiDocument('http://localhost:3000')
		const documentedResponse = (
			document.paths['/api/tags'].get.responses as any
		)['200'].content['application/json'].schema
		const generatedSchema = zodToJsonSchema(TagListResponseSchema, {
			target: 'jsonSchema2019-09',
			$refStrategy: 'none',
			dateStrategy: 'format:date-time',
		}) as Record<string, unknown>
		delete generatedSchema.$schema

		expect(routeResponse.status).toBe(200)
		expect(TagListResponseSchema.safeParse(payload).success).toBe(true)
		expect(documentedResponse).toEqual({
			$ref: '#/components/schemas/TagListResponse',
		})
		expect(document.components.schemas.TagListResponse).toEqual(generatedSchema)
	})
})
