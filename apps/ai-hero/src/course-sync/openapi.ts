const idParameter = (name: string) => ({
	name,
	in: 'path',
	required: true,
	schema: { type: 'string', minLength: 1 },
})

const runResponse = {
	description: 'Redacted sync run receipt',
	content: {
		'application/json': {
			schema: { $ref: '#/components/schemas/SyncRun' },
		},
	},
}

export function buildCourseSyncOpenApiDocument(baseUrl: string) {
	return {
		openapi: '3.1.0',
		info: {
			title: 'AI Hero Draft Course Sync Control Plane',
			version: '1.0.0',
			description:
				'Draft-only control plane. Target product, workshop, section, lesson, visibility, and relation IDs are server-owned.',
		},
		servers: [{ url: baseUrl }],
		paths: {
			'/v1/course-sync/bindings/{bindingId}': {
				get: {
					operationId: 'getSyncBinding',
					security: [{ ReadBearer: [] }],
					parameters: [idParameter('bindingId')],
					responses: {
						200: {
							description: 'Redacted immutable binding assertion',
							content: {
								'application/json': {
									schema: { $ref: '#/components/schemas/SyncBinding' },
								},
							},
						},
					},
				},
			},
			'/v1/course-sync/bindings/{bindingId}/runs:stage': {
				post: {
					operationId: 'stageSourceRevision',
					security: [{ StageBearer: [] }],
					parameters: [
						idParameter('bindingId'),
						{
							name: 'Idempotency-Key',
							in: 'header',
							required: true,
							schema: { type: 'string', minLength: 1 },
						},
					],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									additionalProperties: false,
									required: ['manifest'],
									properties: {
										manifest: { $ref: '#/components/schemas/CourseJsonV3' },
									},
								},
							},
						},
					},
					responses: {
						201: runResponse,
						409: { description: 'Scope or idempotency conflict' },
					},
				},
			},
			'/v1/course-sync/runs/{runId}:preview': {
				post: {
					operationId: 'previewSyncRun',
					security: [{ WorkerBearer: [] }],
					parameters: [idParameter('runId')],
					responses: { 200: runResponse },
				},
			},
			'/v1/course-sync/runs/{runId}': {
				get: {
					operationId: 'getSyncRun',
					security: [{ ReadBearer: [] }],
					parameters: [idParameter('runId')],
					responses: { 200: runResponse },
				},
			},
			'/v1/course-sync/runs/{runId}:apply': {
				post: {
					operationId: 'applyStagedSyncRun',
					security: [{ WorkerBearer: [] }],
					parameters: [
						idParameter('runId'),
						{
							name: 'Idempotency-Key',
							in: 'header',
							required: true,
							schema: { type: 'string' },
						},
					],
					responses: { 200: runResponse },
				},
			},
			'/v1/course-sync/runs/{runId}:rollback': {
				post: {
					operationId: 'rollbackSyncRun',
					security: [{ OperatorBearer: [] }],
					parameters: [
						idParameter('runId'),
						{
							name: 'Idempotency-Key',
							in: 'header',
							required: true,
							schema: { type: 'string' },
						},
					],
					responses: { 200: runResponse },
				},
			},
		},
		components: {
			securitySchemes: Object.fromEntries(
				['ReadBearer', 'StageBearer', 'WorkerBearer', 'OperatorBearer'].map(
					(name) => [name, { type: 'http', scheme: 'bearer' }],
				),
			),
			schemas: {
				CourseJsonV3: {
					type: 'object',
					additionalProperties: false,
					required: [
						'$schema',
						'schemaVersion',
						'courseId',
						'courseVersionId',
						'archiveTTL',
						'courseName',
						'sections',
					],
					properties: {
						$schema: { type: 'string' },
						schemaVersion: { const: 3 },
						courseId: { type: 'string' },
						courseVersionId: { type: 'string' },
						archiveTTL: { const: '90d' },
						courseName: { type: 'string' },
						sections: {
							type: 'array',
							minItems: 1,
							items: { type: 'object' },
						},
					},
				},
				SyncBinding: {
					type: 'object',
					required: ['bindingId', 'status', 'sourceCourseId', 'target'],
					properties: {
						bindingId: { type: 'string', minLength: 1 },
						status: {
							type: 'string',
							enum: ['active', 'suspended', 'revoked'],
						},
						sourceCourseId: { type: 'string', minLength: 1 },
						target: {
							type: 'object',
							required: [
								'productType',
								'anchorResourceType',
								'requiredState',
								'requiredVisibility',
								'sectionMappingPolicy',
							],
							properties: {
								productType: { const: 'self-paced' },
								anchorResourceType: { const: 'workshop' },
								requiredState: { const: 'draft' },
								requiredVisibility: { const: 'unlisted' },
								sectionMappingPolicy: {
									const: 'sections-in-anchor-workshop',
								},
							},
						},
					},
				},
				SyncRun: {
					type: 'object',
					required: [
						'runId',
						'bindingId',
						'courseVersionId',
						'state',
						'noOp',
						'plan',
					],
					properties: {
						runId: { type: 'string' },
						bindingId: { type: 'string' },
						courseVersionId: { type: 'string' },
						state: {
							type: 'string',
							enum: [
								'staged',
								'previewed',
								'applying',
								'applied',
								'failed',
								'rolled_back',
							],
						},
						planSha256: { type: ['string', 'null'] },
						noOp: { type: 'boolean' },
						failureCode: { type: ['string', 'null'] },
						plan: {
							oneOf: [
								{ type: 'null' },
								{
									type: 'object',
									properties: {
										resources: { type: 'array', items: { type: 'object' } },
										media: { type: 'array', items: { type: 'object' } },
									},
								},
							],
						},
						resourceCounts: { type: 'object' },
					},
				},
			},
		},
	} as const
}
