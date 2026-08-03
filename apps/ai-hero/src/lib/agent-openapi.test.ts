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
			'https://json-schema.org/draft/2020-12/schema',
		)
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
