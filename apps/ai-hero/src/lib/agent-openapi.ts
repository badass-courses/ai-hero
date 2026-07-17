const BEARER_SECURITY = [{ bearerAuth: [] }]
const OPTIONAL_BEARER_SECURITY = [{}, ...BEARER_SECURITY]

const jsonContent = (schema: Record<string, unknown>) => ({
	'application/json': { schema },
})

const response = (description: string, schema: Record<string, unknown>) => ({
	description,
	content: jsonContent(schema),
})

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` })

const authErrorResponses = {
	'401': response(
		'Missing, invalid, expired, or revoked bearer credential. Some legacy content reads also use 401 when a valid bearer lacks Content read ability. Read the docs field and inspect token scopes before retrying.',
		schemaRef('ErrorResponse'),
	),
	'403': response(
		'The bearer credential is valid but lacks the required scope or ability. Read the docs field and do not retry the same operation with content:read.',
		schemaRef('ErrorResponse'),
	),
}

type ContentAccess =
	| 'admin-device-token'
	| 'content-read'
	| 'optional-admin-device-token'
	| 'optional-content-read'
	| 'public'

type ContentOperationOptions = {
	operationId: string
	summary: string
	description: string
	access: ContentAccess
	successStatus?: 200 | 201
}

function contentOperation({
	operationId,
	summary,
	description,
	access,
	successStatus = 200,
}: ContentOperationOptions) {
	const security =
		access === 'public'
			? []
			: access === 'optional-content-read' ||
				  access === 'optional-admin-device-token'
				? OPTIONAL_BEARER_SECURITY
				: BEARER_SECURITY
	const isContentRead =
		access === 'content-read' || access === 'optional-content-read'
	const isAdminOnly =
		access === 'admin-device-token' || access === 'optional-admin-device-token'
	const authErrors =
		access === 'optional-content-read' || access === 'public'
			? {}
			: access === 'optional-admin-device-token'
				? { '403': authErrorResponses['403'] }
				: authErrorResponses

	return {
		tags: ['Content API'],
		operationId,
		summary,
		description,
		security,
		'x-required-scopes': isContentRead ? ['content:read'] : [],
		...(isAdminOnly && {
			'x-required-ability':
				access === 'optional-admin-device-token'
					? 'Anonymous legacy access remains available. When a bearer is used, scoped aih_pat_* agent tokens are excluded; an authorized device token retains access.'
					: 'The current operation requires an admin device token with the named Content ability. Scoped aih_pat_* agent tokens are excluded.',
		}),
		'x-agent-token-policy': isContentRead
			? 'content:read grants this read, including draft and private content where applicable.'
			: isAdminOnly
				? 'Excluded from scoped agent tokens. A content:read token receives 403.'
				: access === 'public'
					? 'Public. A bearer token grants no additional privilege.'
					: 'Public results are available anonymously; content:read expands results to privileged content.',
		responses: {
			[String(successStatus)]: response(
				successStatus === 201 ? 'Created.' : 'Successful response.',
				{},
			),
			...authErrors,
		},
	}
}

function preflight(operationId: string) {
	return {
		tags: ['Content API'],
		operationId,
		summary: 'CORS preflight',
		description: 'Public preflight. Bearer credentials are ignored.',
		security: [],
		'x-required-scopes': [],
		'x-agent-token-policy': 'Public preflight only.',
		responses: {
			'200': response('Preflight response.', {}),
		},
	}
}

const contentPaths = {
	'/api/{videoResourceId}': {
		parameters: [
			{
				name: 'videoResourceId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		],
		options: preflight('preflightVideoResource'),
		get: contentOperation({
			operationId: 'getVideoResource',
			summary: 'Get a raw video resource',
			description:
				'Excluded because the payload contains playable Mux identifiers, transcript data, and media internals. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/lessons/{lessonId}/solution': {
		parameters: [
			{
				name: 'lessonId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		],
		options: preflight('preflightLessonSolution'),
		get: contentOperation({
			operationId: 'getLessonSolution',
			summary: 'Read a lesson solution',
			description:
				'content:read includes solutions for readable draft, private, unlisted, and published lessons.',
			access: 'content-read',
		}),
		put: contentOperation({
			operationId: 'updateLessonSolution',
			summary: 'Update a lesson solution',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
		}),
		post: contentOperation({
			operationId: 'createLessonSolution',
			summary: 'Create a lesson solution',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
		}),
		delete: contentOperation({
			operationId: 'deleteLessonSolution',
			summary: 'Delete a lesson solution',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/lessons': {
		options: preflight('preflightLessons'),
		get: contentOperation({
			operationId: 'getLessons',
			summary: 'Read lessons',
			description:
				'content:read returns one or all lessons, including draft, private, unlisted, and published lessons.',
			access: 'content-read',
		}),
		put: contentOperation({
			operationId: 'updateLesson',
			summary: 'Update a lesson',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/memory': {
		options: preflight('preflightMemory'),
		get: contentOperation({
			operationId: 'recallMemory',
			summary: 'Recall support memory',
			description:
				'Excluded because support memory is not CMS content and may contain customer context. Anonymous legacy access remains unchanged; a scoped agent token receives 403.',
			access: 'optional-admin-device-token',
		}),
		post: contentOperation({
			operationId: 'storeMemory',
			summary: 'Store support memory',
			description:
				'Excluded because this mutates support memory, a separate data domain. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/posts': {
		options: preflight('preflightPosts'),
		get: contentOperation({
			operationId: 'getPosts',
			summary: 'Read posts',
			description:
				'content:read returns one or all posts, including draft, private, unlisted, and published posts.',
			access: 'content-read',
		}),
		post: contentOperation({
			operationId: 'createPost',
			summary: 'Create a post',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
			successStatus: 201,
		}),
		put: contentOperation({
			operationId: 'updatePost',
			summary: 'Update a post',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
		}),
		delete: contentOperation({
			operationId: 'deletePost',
			summary: 'Delete a post',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/products/{productId}/availability': {
		parameters: [
			{
				name: 'productId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		],
		options: preflight('preflightProductAvailability'),
		get: contentOperation({
			operationId: 'getProductAvailability',
			summary: 'Read public product availability',
			description:
				'Public commerce availability. A content token adds no fields or draft visibility.',
			access: 'public',
		}),
	},
	'/api/products/{productId}/enrollment': {
		parameters: [
			{
				name: 'productId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		],
		options: preflight('preflightProductEnrollment'),
		get: contentOperation({
			operationId: 'getProductEnrollment',
			summary: 'Read product enrollment analytics',
			description:
				'Excluded because purchase, status, and seat aggregates are commerce analytics rather than CMS content. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/products': {
		options: preflight('preflightProducts'),
		get: contentOperation({
			operationId: 'getProducts',
			summary: 'Read product structure',
			description:
				'content:read includes nested draft and private course structure plus product and price metadata, but never purchases or customers.',
			access: 'content-read',
		}),
		post: contentOperation({
			operationId: 'createProduct',
			summary: 'Create a product',
			description: 'A CMS and commerce write. content:read receives 403.',
			access: 'admin-device-token',
			successStatus: 201,
		}),
		put: contentOperation({
			operationId: 'updateProduct',
			summary: 'Update a product',
			description: 'A CMS and commerce write. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/resources': {
		options: preflight('preflightResources'),
		get: contentOperation({
			operationId: 'getResources',
			summary: 'Read sanitized content resources',
			description:
				'content:read includes draft and private CMS resources through a safe projection. Playable Mux identifiers and other capability-bearing media fields stay excluded.',
			access: 'content-read',
		}),
		put: contentOperation({
			operationId: 'updateResource',
			summary: 'Update a resource',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
		}),
		post: contentOperation({
			operationId: 'createResource',
			summary: 'Create a resource',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
			successStatus: 201,
		}),
	},
	'/api/search': {
		options: preflight('preflightSearch'),
		get: contentOperation({
			operationId: 'searchContent',
			summary: 'Search content',
			description:
				'Anonymous callers see public published hits. content:read also sees draft and private hits through the existing safe field allowlist; embeddings and full descriptions stay excluded.',
			access: 'optional-content-read',
		}),
	},
	'/api/skills/changelog': {
		options: preflight('preflightSkillsChangelog'),
		post: contentOperation({
			operationId: 'createSkillsChangelog',
			summary: 'Create a skills changelog entry',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
			successStatus: 201,
		}),
	},
	'/api/surveys/analytics': {
		options: preflight('preflightSurveyAnalytics'),
		get: contentOperation({
			operationId: 'getSurveyAnalytics',
			summary: 'Read survey analytics',
			description:
				'Excluded because the payload contains survey answers and personally identifying fields. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/surveys': {
		options: preflight('preflightSurveys'),
		get: contentOperation({
			operationId: 'getSurveys',
			summary: 'Read survey definitions',
			description:
				'content:read includes draft and private survey definitions and questions, but never responses or analytics.',
			access: 'content-read',
		}),
		post: contentOperation({
			operationId: 'createSurvey',
			summary: 'Create a survey',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
			successStatus: 201,
		}),
		patch: contentOperation({
			operationId: 'updateSurvey',
			summary: 'Update a survey',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
		}),
		delete: contentOperation({
			operationId: 'deleteSurvey',
			summary: 'Delete a survey',
			description: 'A CMS write. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/uploads/multipart/complete': {
		options: preflight('preflightCompleteMultipartUpload'),
		post: contentOperation({
			operationId: 'completeMultipartUpload',
			summary: 'Complete a multipart upload',
			description:
				'Excluded because upload control mutates storage. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/uploads/multipart/create': {
		options: preflight('preflightCreateMultipartUpload'),
		post: contentOperation({
			operationId: 'createMultipartUpload',
			summary: 'Create a multipart upload',
			description:
				'Excluded because upload control grants a storage write capability. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/uploads/multipart/part-url': {
		options: preflight('preflightMultipartPartUrl'),
		get: contentOperation({
			operationId: 'getMultipartPartUrl',
			summary: 'Get a multipart upload part URL',
			description:
				'Excluded because the signed URL grants storage write capability despite using HTTP GET. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/uploads/new': {
		options: preflight('preflightNewUpload'),
		post: contentOperation({
			operationId: 'createUpload',
			summary: 'Start video processing',
			description:
				'Excluded because this starts processing and writes media state. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
	'/api/uploads/signed-url': {
		get: contentOperation({
			operationId: 'getUploadSignedUrl',
			summary: 'Get a signed storage URL',
			description:
				'Excluded because a signed URL is a capability that grants direct storage access. content:read receives 403.',
			access: 'admin-device-token',
		}),
	},
}

const personalAccessTokenPaths = {
	'/api/personal-access-tokens': {
		get: {
			tags: ['Agent tokens'],
			operationId: 'listPersonalAccessTokens',
			summary: 'List the caller’s agent tokens',
			description:
				'Admin-only. Use an admin device token. Returns safe metadata for tokens owned by the caller and never returns raw tokens or token hashes.',
			security: BEARER_SECURITY,
			'x-required-scopes': [],
			'x-required-ability': 'manage all',
			responses: {
				'200': response('Owned agent-token metadata.', {
					type: 'array',
					items: schemaRef('PersonalAccessToken'),
				}),
				...authErrorResponses,
				'500': response('Internal server error.', schemaRef('ErrorResponse')),
			},
		},
		post: {
			tags: ['Agent tokens'],
			operationId: 'mintPersonalAccessToken',
			summary: 'Mint a scoped agent token',
			description:
				'Admin-only and mint-for-self. Use an admin device token. A 201 response returns the complete aih_pat_* token exactly once; store it immediately because list responses never return it.',
			security: BEARER_SECURITY,
			'x-required-scopes': [],
			'x-required-ability': 'manage all',
			requestBody: {
				required: true,
				content: jsonContent(schemaRef('MintPersonalAccessTokenRequest')),
			},
			responses: {
				'201': response(
					'Created. The token field is returned once and cannot be recovered later.',
					schemaRef('MintPersonalAccessTokenResponse'),
				),
				'400': response(
					'Invalid name, scope, or expiresAt.',
					schemaRef('ErrorResponse'),
				),
				...authErrorResponses,
				'503': response(
					'Personal access token hashing is not configured.',
					schemaRef('ErrorResponse'),
				),
				'500': response('Internal server error.', schemaRef('ErrorResponse')),
			},
		},
	},
	'/api/personal-access-tokens/{id}': {
		parameters: [
			{
				name: 'id',
				in: 'path',
				required: true,
				description: 'Owned personal access token id from the list operation.',
				schema: { type: 'string' },
			},
		],
		delete: {
			tags: ['Agent tokens'],
			operationId: 'revokePersonalAccessToken',
			summary: 'Revoke an owned agent token',
			description:
				'Admin-only, owned-token-only, and idempotent. Use an admin device token. Revocation is the immediate kill switch; the revoked token subsequently receives 401.',
			security: BEARER_SECURITY,
			'x-required-scopes': [],
			'x-required-ability': 'manage all',
			responses: {
				'200': response(
					'Current token metadata with revokedAt set.',
					schemaRef('PersonalAccessToken'),
				),
				...authErrorResponses,
				'404': response(
					'No owned token exists with this id.',
					schemaRef('ErrorResponse'),
				),
				'500': response('Internal server error.', schemaRef('ErrorResponse')),
			},
		},
	},
}

export function buildAgentOpenApiDocument(baseUrl: string) {
	const normalizedBaseUrl = baseUrl.replace(/\/$/, '')

	return {
		openapi: '3.1.0',
		info: {
			title: 'AI Hero Agent and Content API',
			version: '1.0.0',
			description:
				'Start at /api for the self-onboarding agent-token guide. Scoped aih_pat_* tokens use content:read for privileged CMS reads; admin device tokens retain administrative abilities.',
		},
		servers: [{ url: normalizedBaseUrl }],
		tags: [
			{
				name: 'Agent tokens',
				description: 'Admin-only mint, list, and revoke operations.',
			},
			{
				name: 'Content API',
				description: 'The approved content-token coverage matrix.',
			},
		],
		paths: {
			...contentPaths,
			...personalAccessTokenPaths,
		},
		components: {
			securitySchemes: {
				bearerAuth: {
					type: 'http',
					scheme: 'bearer',
					description:
						'Send Authorization: Bearer <token>. Two bearer kinds are accepted: scoped aih_pat_* agent tokens, whose ability comes only from their scopes, and admin device tokens, whose user abilities can administer tokens and CMS writes. Never put either token in a query string.',
				},
			},
			schemas: {
				ErrorResponse: {
					type: 'object',
					required: ['error'],
					properties: {
						error: {
							oneOf: [
								{ type: 'string' },
								{
									type: 'object',
									required: ['message', 'code'],
									properties: {
										message: { type: 'string' },
										code: { type: 'string' },
									},
								},
							],
						},
						details: {},
						docs: {
							type: 'string',
							description:
								'Discovery URL for correcting authentication or authorization failures.',
							example: '/api',
						},
					},
					additionalProperties: true,
				},
				MintPersonalAccessTokenRequest: {
					type: 'object',
					required: ['name', 'scopes'],
					properties: {
						name: { type: 'string', minLength: 1, maxLength: 100 },
						scopes: {
							type: 'array',
							minItems: 1,
							items: {
								type: 'string',
								enum: ['content:read', 'analytics:read', 'analytics:chat'],
							},
						},
						expiresAt: {
							type: 'string',
							format: 'date-time',
							description:
								'Optional future expiry. Omit for no automatic expiry.',
						},
					},
					additionalProperties: false,
				},
				PersonalAccessToken: {
					type: 'object',
					required: [
						'id',
						'name',
						'tokenPrefix',
						'scopes',
						'createdAt',
						'lastUsedAt',
						'expiresAt',
						'revokedAt',
					],
					properties: {
						id: { type: 'string' },
						name: { type: 'string' },
						tokenPrefix: { type: 'string', example: 'aih_pat_abcd1234' },
						scopes: { type: 'array', items: { type: 'string' } },
						createdAt: { type: ['string', 'null'], format: 'date-time' },
						lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
						expiresAt: { type: ['string', 'null'], format: 'date-time' },
						revokedAt: { type: ['string', 'null'], format: 'date-time' },
					},
					additionalProperties: false,
				},
				MintPersonalAccessTokenResponse: {
					type: 'object',
					required: [
						'token',
						'id',
						'name',
						'tokenPrefix',
						'scopes',
						'createdAt',
						'lastUsedAt',
						'expiresAt',
						'revokedAt',
					],
					properties: {
						token: {
							type: 'string',
							pattern: '^aih_pat_',
							description:
								'Returned only in the 201 mint response. Store it now.',
						},
						id: { type: 'string' },
						name: { type: 'string' },
						tokenPrefix: { type: 'string', example: 'aih_pat_abcd1234' },
						scopes: { type: 'array', items: { type: 'string' } },
						createdAt: { type: ['string', 'null'], format: 'date-time' },
						lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
						expiresAt: { type: ['string', 'null'], format: 'date-time' },
						revokedAt: { type: ['string', 'null'], format: 'date-time' },
					},
					additionalProperties: false,
				},
			},
		},
	}
}
