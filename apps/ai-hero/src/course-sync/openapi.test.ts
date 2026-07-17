import { describe, expect, it } from 'vitest'

import { buildCourseSyncOpenApiDocument } from './openapi'

describe('course sync OpenAPI contract', () => {
	it('exposes only draft control-plane operations and keeps target IDs out of stage input', () => {
		const document = buildCourseSyncOpenApiDocument('https://www.aihero.dev')
		const operations = Object.values(document.paths).flatMap((path) =>
			Object.values(path).map((operation) => operation.operationId),
		)
		expect(operations).toEqual([
			'getSyncBinding',
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
	})
})
