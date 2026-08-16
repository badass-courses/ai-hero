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
			title: 'AI Hero Course Sync Control Plane',
			version: '2.0.0',
			description:
				'Operator-apply control plane. Target product, workshop, child contracts, and relation IDs are server-owned.',
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
			'/v1/course-sync/bindings/{bindingId}/poll-state:release': {
				post: {
					operationId: 'releaseCourseSyncPollHold',
					security: [{ OperatorBearer: [] }],
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
									required: ['reason'],
									properties: {
										reason: { type: 'string', minLength: 1, maxLength: 500 },
									},
								},
							},
						},
					},
					responses: {
						200: { description: 'Audited poll hold release receipt' },
						409: { description: 'Target still mismatched or state not held' },
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
					security: [{ WorkerBearer: [] }, { OperatorBearer: [] }],
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
					required: [
						'bindingId',
						'contractVersion',
						'status',
						'sourceCourseId',
						'applyPolicy',
						'target',
					],
					properties: {
						bindingId: { type: 'string', minLength: 1 },
						contractVersion: { const: 2 },
						status: {
							type: 'string',
							enum: ['active', 'suspended', 'revoked'],
						},
						sourceCourseId: { type: 'string', minLength: 1 },
						applyPolicy: { enum: ['auto', 'operator'] },
						target: {
							type: 'object',
							required: [
								'product',
								'workshop',
								'managedChildren',
								'sectionMappingPolicy',
							],
							properties: {
								product: {
									type: 'object',
									properties: {
										type: { const: 'self-paced' },
										state: { const: 'published' },
										visibility: { const: 'public' },
									},
								},
								workshop: {
									type: 'object',
									properties: {
										type: { const: 'workshop' },
										state: { const: 'published' },
										visibility: { const: 'unlisted' },
									},
								},
								managedChildren: {
									type: 'object',
									properties: {
										state: { const: 'draft' },
										visibility: { const: 'unlisted' },
									},
								},
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
