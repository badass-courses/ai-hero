import { describe, expect, it } from 'vitest'

import { buildCourseSyncOpenApiDocument } from './openapi'

describe('course sync OpenAPI contract', () => {
	it('exposes operator release/apply while keeping target IDs out of stage input', () => {
		const document = buildCourseSyncOpenApiDocument('https://www.aihero.dev')
		const operations = Object.values(document.paths).flatMap((path) =>
			Object.values(path).map((operation) => operation.operationId),
		)
		expect(operations).toEqual([
			'getSyncBinding',
			'releaseCourseSyncPollHold',
			'stageSourceRevision',
			'previewSyncRun',
			'getSyncRun',
			'applyStagedSyncRun',
			'rollbackSyncRun',
		])
		expect(JSON.stringify(document)).not.toContain('publishSyncRun')
		const stage =
			document.paths['/v1/course-sync/bindings/{bindingId}/runs:stage'].post
		const schema = stage.requestBody.content['application/json'].schema
		expect(Object.keys(schema.properties)).toEqual(['manifest'])
		expect(schema.additionalProperties).toBe(false)
		expect(
			document.components.schemas.CourseJsonV3.properties.sections,
		).toMatchObject({ minItems: 1 })
		expect(
			'maxItems' in
				document.components.schemas.CourseJsonV3.properties.sections,
		).toBe(false)
		expect(
			document.components.schemas.SyncBinding.properties.target.properties
				.sectionMappingPolicy,
		).toEqual({ const: 'sections-in-anchor-workshop' })
		expect(
			document.components.schemas.SyncBinding.properties.target.properties
				.product.properties,
		).toMatchObject({
			type: { const: 'self-paced' },
			state: { const: 'published' },
			visibility: { const: 'public' },
		})
		expect(
			document.components.schemas.SyncBinding.properties.target.properties
				.managedChildren.properties,
		).toEqual({
			state: { const: 'draft' },
			visibility: { const: 'unlisted' },
		})
		expect(
			document.paths['/v1/course-sync/runs/{runId}:apply'].post.security,
		).toEqual([{ WorkerBearer: [] }, { OperatorBearer: [] }])
	})
})
