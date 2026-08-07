import { z, type ZodTypeAny } from 'zod'

import {
	AddListItemRequestSchema,
	CommandPreflightResultSchema,
	CompleteMultipartUploadResponseSchema,
	CompleteMultipartUploadSchema,
	CreateMultipartUploadResponseSchema,
	CreateMultipartUploadSchema,
	CreateShortlinkSchema,
	CreateTagRequestSchema,
	DeleteMessageResponseSchema,
	EmptyObjectResponseSchema,
	ErrorResponseSchema,
	LessonReadResponseSchema,
	LessonResponseSchema,
	LessonUpdateRequestSchema,
	ListItemLocationSchema,
	ListItemRowSchema,
	MintPersonalAccessTokenResponseSchema,
	MintPersonalAccessTokenSchema,
	MoveListItemsRequestSchema,
	MoveListItemsResultSchema,
	MultipartPartUrlResponseSchema,
	NextActionSchema,
	PageReadResponseSchema,
	PageResponseSchema,
	PersonalAccessTokenResponseSchema,
	PostCreateRequestSchema,
	PostReadResponseSchema,
	PostResponseSchema,
	PostTagInputSchema,
	PostTagMutationResponseSchema,
	PostUpdateRequestSchema,
	ProductAvailabilityResponseSchema,
	ProductCreateApiSchema,
	ProductReadResponseSchema,
	ProductResponseSchema,
	ProductUpdateApiSchema,
	ResourceCreateRequestSchema,
	ResourceReadResponseSchema,
	ResourceResponseSchema,
	ResourceUpdateRequestSchema,
	SearchResultSchema,
	ShortlinkReadResponseSchema,
	ShortlinkResponseSchema,
	SignedUploadUrlResponseSchema,
	SkillChangelogPostSchema,
	SkillChangelogResultSchema,
	SolutionCreateRequestSchema,
	SolutionResponseSchema,
	SolutionUpdateRequestSchema,
	TagListResponseSchema,
	TagResponseSchema,
	UpdatePageSchema,
	UpdateShortlinkSchema,
	UploadBodySchema,
	UploadStartedResponseSchema,
	VideoResourceResponseSchema,
} from './agent-api-contracts'

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
		'Missing, malformed, expired, or revoked bearer credential. Use /api to discover the accepted bearer formats before retrying.',
		schemaRef('ErrorResponse'),
	),
	'403': response(
		'The bearer credential is valid, but the PAT lacks a required write scope, the requested mutation exceeds that scope (for example, content:write against published content), or the role-derived device token lacks the named ability. content:read never authorizes writes.',
		schemaRef('ErrorResponse'),
	),
}

const commonErrorResponses = {
	'400': response(
		'Invalid request parameters or body.',
		schemaRef('ErrorResponse'),
	),
	'404': response(
		'The requested resource does not exist.',
		schemaRef('ErrorResponse'),
	),
	'500': response('Internal server error.', schemaRef('ErrorResponse')),
}

type ContentAccess =
	| 'content-read'
	| 'device-token'
	| 'optional-content-read'
	| 'public'

type ContentOperationOptions = {
	operationId: string
	summary: string
	description: string
	access: ContentAccess
	responseSchema: string
	requiredAbility?: string
	requiredScopes?: string[]
	scopeRequirements?: string
	agentTokenPolicy?: string
	requestSchema?: string
	parameters?: Array<Record<string, unknown>>
	successStatus?: 200 | 201
	extraResponses?: Record<string, unknown>
}

function contentOperation({
	operationId,
	summary,
	description,
	access,
	responseSchema,
	requiredAbility,
	requiredScopes,
	scopeRequirements,
	agentTokenPolicy,
	requestSchema,
	parameters,
	successStatus = 200,
	extraResponses,
}: ContentOperationOptions) {
	const security =
		access === 'public'
			? []
			: access === 'optional-content-read'
				? OPTIONAL_BEARER_SECURITY
				: BEARER_SECURITY
	const isContentRead =
		access === 'content-read' || access === 'optional-content-read'
	const isDeviceToken = access === 'device-token'
	const acceptsWritePat = isDeviceToken && Boolean(requiredScopes?.length)
	const authErrors =
		access === 'public' || access === 'optional-content-read'
			? {}
			: authErrorResponses

	return {
		tags: ['Content API'],
		operationId,
		summary,
		description,
		security,
		'x-required-scopes': isContentRead
			? ['content:read']
			: (requiredScopes ?? []),
		...(scopeRequirements && {
			'x-scope-requirements': scopeRequirements,
		}),
		...(isDeviceToken && {
			'x-required-ability': requiredAbility,
		}),
		'x-agent-token-policy': isContentRead
			? access === 'optional-content-read'
				? 'Anonymous callers receive public results. content:read also permits privileged content.'
				: 'A scoped aih_pat_* token with content:read is accepted.'
			: acceptsWritePat
				? agentTokenPolicy || scopeRequirements
				: isDeviceToken
					? `Scoped aih_pat_* tokens are excluded. Use a role-derived device token with ${requiredAbility}.`
					: 'Public. A bearer token grants no extra privilege.',
		...(parameters?.length ? { parameters } : {}),
		...(requestSchema && {
			requestBody: {
				required: true,
				content: jsonContent(schemaRef(requestSchema)),
			},
		}),
		responses: {
			[String(successStatus)]: response(
				successStatus === 201 ? 'Created.' : 'Successful response.',
				schemaRef(responseSchema),
			),
			...authErrors,
			...extraResponses,
		},
	}
}

function preflight(
	operationId: string,
	responseSchema = 'EmptyObjectResponse',
) {
	return {
		tags: ['Content API'],
		operationId,
		summary: 'CORS preflight',
		description: 'Public preflight. Bearer credentials are ignored.',
		security: [],
		'x-required-scopes': [],
		'x-agent-token-policy': 'Public preflight only.',
		responses: {
			'200': response('Preflight response.', schemaRef(responseSchema)),
		},
	}
}

const queryParameter = (
	name: string,
	description: string,
	schema: Record<string, unknown> = { type: 'string' },
	required = false,
) => ({ name, in: 'query', required, description, schema })

const pathParameter = (name: string, description: string) => ({
	name,
	in: 'path',
	required: true,
	description,
	schema: { type: 'string' },
})

const contentPaths = {
	'/api/{videoResourceId}': {
		parameters: [pathParameter('videoResourceId', 'Video resource id.')],
		options: preflight('preflightVideoResource'),
		get: contentOperation({
			operationId: 'getVideoResource',
			summary: 'Get a raw video resource',
			description:
				'Returns media internals, including playable Mux identifiers and transcript data. This route is not available to scoped PATs.',
			access: 'device-token',
			requiredAbility: 'create Content',
			responseSchema: 'VideoResourceResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/lessons/{lessonId}/solution': {
		parameters: [pathParameter('lessonId', 'Parent lesson id or slug.')],
		options: preflight('preflightLessonSolution'),
		get: contentOperation({
			operationId: 'getLessonSolution',
			summary: 'Read a lesson solution',
			description:
				'content:read includes solutions for readable draft, private, unlisted, and published lessons.',
			access: 'content-read',
			responseSchema: 'SolutionResponse',
			extraResponses: commonErrorResponses,
		}),
		put: contentOperation({
			operationId: 'updateLessonSolution',
			summary: 'Update a lesson solution',
			description: 'Updates the existing solution attached to the lesson.',
			access: 'device-token',
			requiredAbility: 'manage the target lesson Content subject',
			requestSchema: 'SolutionUpdateRequest',
			responseSchema: 'SolutionResponse',
			extraResponses: commonErrorResponses,
		}),
		post: contentOperation({
			operationId: 'createLessonSolution',
			summary: 'Create a lesson solution',
			description: 'Creates one solution attached to the lesson.',
			access: 'device-token',
			requiredAbility: 'manage the target lesson Content subject',
			requestSchema: 'SolutionCreateRequest',
			responseSchema: 'SolutionResponse',
			extraResponses: commonErrorResponses,
		}),
		delete: contentOperation({
			operationId: 'deleteLessonSolution',
			summary: 'Delete a lesson solution',
			description: 'Deletes the solution attached to the lesson.',
			access: 'device-token',
			requiredAbility: 'manage the target lesson Content subject',
			responseSchema: 'DeleteMessageResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/lessons': {
		options: preflight('preflightLessons'),
		get: contentOperation({
			operationId: 'getLessons',
			summary: 'Read lessons',
			description:
				'Return one lesson with ?slugOrId= or all readable lessons when omitted.',
			access: 'content-read',
			parameters: [queryParameter('slugOrId', 'Optional lesson id or slug.')],
			responseSchema: 'LessonReadResponse',
			extraResponses: commonErrorResponses,
		}),
		put: contentOperation({
			operationId: 'updateLesson',
			summary: 'Update or publish a lesson',
			description:
				'Use ?id=<lesson-id>. For PATs, action=save requires content:write and only updates an existing draft; action=publish requires content:publish. Saving tags also requires content:relations. PATs cannot unpublish or archive lessons.',
			access: 'device-token',
			requiredAbility: 'update Content and manage the target lesson',
			requiredScopes: ['content:write', 'content:publish', 'content:relations'],
			scopeRequirements:
				'PAT: content:write for action=save, content:publish for action=publish, and content:relations in addition to content:write when the save body contains tags.',
			parameters: [queryParameter('id', 'Lesson id.', undefined, true)],
			requestSchema: 'LessonUpdateRequest',
			responseSchema: 'LessonResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/posts': {
		options: preflight('preflightPosts'),
		get: contentOperation({
			operationId: 'getPosts',
			summary: 'Read posts',
			description:
				'Return one post with ?slugOrId= or all readable posts when omitted.',
			access: 'content-read',
			parameters: [queryParameter('slugOrId', 'Optional post id or slug.')],
			responseSchema: 'PostReadResponse',
			extraResponses: commonErrorResponses,
		}),
		post: contentOperation({
			operationId: 'createPost',
			summary: 'Create a post',
			description:
				'Creates a draft post. The server supplies createdById. PATs also need content:relations when videoResourceId or parentLessonId is present.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requiredScopes: ['content:write', 'content:relations'],
			scopeRequirements:
				'PAT: content:write is required. content:relations is additionally required when videoResourceId or parentLessonId is present.',
			requestSchema: 'PostCreateRequest',
			responseSchema: 'PostResponse',
			successStatus: 201,
			extraResponses: commonErrorResponses,
		}),
		put: contentOperation({
			operationId: 'updatePost',
			summary: 'Update or publish a post',
			description:
				'Use ?id=<post-id>&action=<publish|save>. For PATs, save requires content:write and only updates an existing draft; publish requires content:publish. Saving tags or videoResourceId also requires content:relations. PATs cannot unpublish, archive, or change fields.state.',
			access: 'device-token',
			requiredAbility: 'update Content and manage the target post',
			requiredScopes: ['content:write', 'content:publish', 'content:relations'],
			scopeRequirements:
				'PAT: content:write for action=save or no action, content:publish for action=publish, and content:relations in addition when the body contains tags or videoResourceId.',
			parameters: [
				queryParameter('id', 'Post id.', undefined, true),
				queryParameter('action', 'State transition or save action.', {
					type: 'string',
					enum: ['publish', 'unpublish', 'archive', 'save'],
				}),
			],
			requestSchema: 'PostUpdateRequest',
			responseSchema: 'PostResponse',
			extraResponses: commonErrorResponses,
		}),
		delete: contentOperation({
			operationId: 'deletePost',
			summary: 'Delete a post',
			description: 'Use ?id=<post-id>.',
			access: 'device-token',
			requiredAbility: 'delete the target Content subject',
			parameters: [queryParameter('id', 'Post id.', undefined, true)],
			responseSchema: 'DeleteMessageResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/products/{productId}/availability': {
		parameters: [pathParameter('productId', 'Product id.')],
		options: preflight('preflightProductAvailability'),
		get: contentOperation({
			operationId: 'getProductAvailability',
			summary: 'Read public product availability',
			description:
				'Returns remaining quantity and whether capacity is unlimited.',
			access: 'public',
			responseSchema: 'ProductAvailabilityResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/products': {
		options: preflight('preflightProducts'),
		get: contentOperation({
			operationId: 'getProducts',
			summary: 'Read product structure',
			description:
				'Return one product with ?slugOrId= or all products. Nested course structure is included; purchases and customers are not.',
			access: 'content-read',
			parameters: [queryParameter('slugOrId', 'Optional product id or slug.')],
			responseSchema: 'ProductReadResponse',
			extraResponses: commonErrorResponses,
		}),
		post: contentOperation({
			operationId: 'createProduct',
			summary: 'Create a product',
			description: 'Creates the product and optional explicit slug.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requestSchema: 'ProductCreateRequest',
			responseSchema: 'ProductResponse',
			successStatus: 201,
			extraResponses: commonErrorResponses,
		}),
		put: contentOperation({
			operationId: 'updateProduct',
			summary: 'Update a product',
			description: 'Updates one or more product fields.',
			access: 'device-token',
			requiredAbility: 'update Content',
			requestSchema: 'ProductUpdateRequest',
			responseSchema: 'ProductResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/resources': {
		options: preflight('preflightResources'),
		get: contentOperation({
			operationId: 'getResources',
			summary: 'Read sanitized content resources',
			description:
				'Return one resource by ?slugOrId= and optional ?type=. Carries two levels of children in position order, so a sectioned list shows what each section holds. List-all is allowed only for ?type=list. Mux capability fields are removed recursively.',
			access: 'content-read',
			parameters: [
				queryParameter('slugOrId', 'Resource id or slug.'),
				queryParameter('type', 'Optional resource type filter.'),
			],
			responseSchema: 'ResourceReadResponse',
			extraResponses: commonErrorResponses,
		}),
		put: contentOperation({
			operationId: 'updateResource',
			summary: 'Merge resource fields',
			description:
				'Use ?id=<resource-id>. fields are merged, not replaced. Video chapters use the real chapter validator, are sorted by start time, and must fit the video duration.',
			access: 'device-token',
			requiredAbility: 'update Content',
			parameters: [queryParameter('id', 'Resource id.', undefined, true)],
			requestSchema: 'ResourceUpdateRequest',
			responseSchema: 'ResourceResponse',
			extraResponses: commonErrorResponses,
		}),
		post: contentOperation({
			operationId: 'createResource',
			summary: 'Create a generic resource',
			description:
				'Creates a draft, unlisted resource. The server generates id and slug unless fields.slug is supplied.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requestSchema: 'ResourceCreateRequest',
			responseSchema: 'ResourceResponse',
			successStatus: 201,
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/lists/{listId}/resources': {
		parameters: [pathParameter('listId', "The list's id or its slug.")],
		options: preflight('preflightListResources'),
		post: contentOperation({
			operationId: 'addResourceToList',
			summary: 'Add a resource to a list or one of its sections',
			description:
				'Omit parentId to add at the top level; pass a SECTION id to nest under it (only sections parent, and never each other). Appends after the last sibling. 409 when the parent already holds the resource.',
			access: 'device-token',
			requiredAbility: 'update Content',
			requiredScopes: ['content:relations'],
			scopeRequirements: 'PAT: content:relations is required.',
			requestSchema: 'AddListItemRequest',
			responseSchema: 'ListItemRow',
			successStatus: 201,
			extraResponses: {
				...commonErrorResponses,
				'409': response(
					'The parent already holds this resource.',
					schemaRef('ErrorResponse'),
				),
			},
		}),
		put: contentOperation({
			operationId: 'moveListResources',
			summary: 'Reorder list items or move them between sections',
			description:
				'Applies the whole batch in one transaction, then renumbers every touched parent densely — positions stay unique and gap free regardless of the positions sent, and the response lists every applied write, sibling renumbering included. Each resourceId may appear once. Omit parentId to reorder an item in place; pass the list id to pull it out of a section. Any invalid item fails the batch before anything is written.',
			access: 'device-token',
			requiredAbility: 'update Content',
			requiredScopes: ['content:relations'],
			scopeRequirements: 'PAT: content:relations is required.',
			requestSchema: 'MoveListItemsRequest',
			responseSchema: 'MoveListItemsResult',
			extraResponses: commonErrorResponses,
		}),
		delete: contentOperation({
			operationId: 'removeResourceFromList',
			summary: 'Remove a resource from a list',
			description:
				'Removes one placement and answers with where it sat. When the resource sits in more than one place, parentId selects the placement; omitted, the top-level placement wins. 404 when the list does not hold it.',
			access: 'device-token',
			requiredAbility: 'update Content',
			requiredScopes: ['content:relations'],
			scopeRequirements: 'PAT: content:relations is required.',
			parameters: [
				queryParameter('resourceId', 'The resource to remove.', undefined, true),
				queryParameter(
					'parentId',
					'Placement selector: the section id (or the list id) to remove from.',
				),
			],
			responseSchema: 'ListItemLocation',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/search': {
		options: preflight('preflightSearch'),
		get: contentOperation({
			operationId: 'searchContent',
			summary: 'Search content',
			description:
				'Anonymous callers see public published hits. content:read also sees privileged hits through the safe field allowlist.',
			access: 'optional-content-read',
			parameters: [
				queryParameter('q', 'Search query.', undefined, true),
				queryParameter('type', 'Optional content type filter.'),
				queryParameter('per_page', 'Result count, capped at 20.', {
					type: 'integer',
					minimum: 1,
					maximum: 20,
					default: 5,
				}),
				queryParameter('semantic', 'Enable hybrid semantic search.', {
					type: 'boolean',
					default: false,
				}),
			],
			responseSchema: 'SearchSuccessResponse',
			extraResponses: {
				'400': commonErrorResponses['400'],
				'500': commonErrorResponses['500'],
				'503': response(
					'Search is not configured.',
					schemaRef('ErrorResponse'),
				),
			},
		}),
	},
	'/api/skills/changelog': {
		options: preflight(
			'preflightSkillsChangelog',
			'CommandPreflightSuccessResponse',
		),
		post: contentOperation({
			operationId: 'createSkillsChangelog',
			summary: 'Create a Skills Changelog entry',
			description:
				'Creates a draft or published Skills Changelog resource and optionally attaches a video. The canonical success shape is {ok, command, result, next_actions}; deprecated top-level id and slug mirror the nested result for compatibility.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requiredScopes: ['content:write', 'content:publish', 'content:relations'],
			scopeRequirements:
				'PAT: content:write is required. content:publish is additionally required when state=published. content:relations is additionally required when videoResourceId is present.',
			requestSchema: 'SkillChangelogRequest',
			responseSchema: 'SkillChangelogSuccessResponse',
			successStatus: 201,
			extraResponses: {
				...commonErrorResponses,
				'409': response('The slug already exists.', schemaRef('ErrorResponse')),
			},
		}),
	},
	'/api/uploads/multipart/create': {
		options: preflight('preflightCreateMultipartUpload'),
		post: contentOperation({
			operationId: 'createMultipartUpload',
			summary: 'Create a multipart upload',
			description:
				'Starts an S3 multipart upload and returns its id, key, and public URL.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requiredScopes: ['media:upload'],
			scopeRequirements: 'PAT: media:upload is required.',
			requestSchema: 'CreateMultipartUploadRequest',
			responseSchema: 'CreateMultipartUploadResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/uploads/multipart/part-url': {
		options: preflight('preflightMultipartPartUrl'),
		get: contentOperation({
			operationId: 'getMultipartPartUrl',
			summary: 'Get a multipart upload part URL',
			description:
				'Returns a one-hour signed URL that grants direct storage write access.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requiredScopes: ['media:upload'],
			scopeRequirements: 'PAT: media:upload is required.',
			parameters: [
				queryParameter('key', 'Multipart object key.', undefined, true),
				queryParameter('uploadId', 'Multipart upload id.', undefined, true),
				queryParameter(
					'partNumber',
					'Positive part number.',
					{
						type: 'integer',
						minimum: 1,
					},
					true,
				),
			],
			responseSchema: 'MultipartPartUrlResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/uploads/multipart/complete': {
		options: preflight('preflightCompleteMultipartUpload'),
		post: contentOperation({
			operationId: 'completeMultipartUpload',
			summary: 'Complete a multipart upload',
			description:
				'Completes an S3 multipart upload from uploaded part numbers and ETags.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requiredScopes: ['media:upload'],
			scopeRequirements: 'PAT: media:upload is required.',
			requestSchema: 'CompleteMultipartUploadRequest',
			responseSchema: 'CompleteMultipartUploadResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/uploads/new': {
		options: preflight('preflightNewUpload'),
		post: contentOperation({
			operationId: 'createUpload',
			summary: 'Start video processing',
			description:
				'Queues video processing for an uploaded file and parent content resource. PATs may target only post, lesson, or skill-changelog parents. The route currently returns no job id.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requiredScopes: ['media:upload', 'content:relations'],
			scopeRequirements:
				'PAT: media:upload and content:relations are both required.',
			requestSchema: 'UploadRequest',
			responseSchema: 'UploadStartedResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/uploads/signed-url': {
		get: contentOperation({
			operationId: 'getUploadSignedUrl',
			summary: 'Get a signed storage URL',
			description:
				'Returns a one-hour signed PUT URL and its resulting public URL.',
			access: 'device-token',
			requiredAbility: 'create Content',
			parameters: [
				queryParameter('objectName', 'Original file name.', undefined, true),
			],
			responseSchema: 'SignedUploadUrlResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/shortlinks': {
		options: preflight('preflightShortlinks'),
		get: contentOperation({
			operationId: 'getShortlinks',
			summary: 'List, search, or read short links',
			description:
				'Use ?id= for one link or ?search= to filter. shortlinks:manage PAT responses omit click counts and cannot use analytics modes; role-derived admin device tokens retain analytics access.',
			access: 'device-token',
			requiredAbility: 'manage all',
			requiredScopes: ['shortlinks:manage'],
			scopeRequirements: 'PAT: shortlinks:manage is required.',
			parameters: [
				queryParameter('id', 'Optional short-link id.'),
				queryParameter('search', 'Optional slug, URL, or description search.'),
			],
			responseSchema: 'ShortlinkReadResponse',
			extraResponses: commonErrorResponses,
		}),
		post: contentOperation({
			operationId: 'createShortlink',
			summary: 'Create a short link',
			description:
				'Creates a short link. The server generates a slug when omitted. PAT responses omit click counts.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requiredScopes: ['shortlinks:manage'],
			scopeRequirements: 'PAT: shortlinks:manage is required.',
			requestSchema: 'CreateShortlinkRequest',
			responseSchema: 'ShortlinkResponse',
			successStatus: 201,
			extraResponses: {
				...commonErrorResponses,
				'409': response('The slug already exists.', schemaRef('ErrorResponse')),
			},
		}),
		patch: contentOperation({
			operationId: 'updateShortlink',
			summary: 'Update a short link',
			description:
				'Updates the selected short-link fields. PAT responses omit click counts.',
			access: 'device-token',
			requiredAbility: 'update Content',
			requiredScopes: ['shortlinks:manage'],
			scopeRequirements: 'PAT: shortlinks:manage is required.',
			requestSchema: 'UpdateShortlinkRequest',
			responseSchema: 'ShortlinkResponse',
			extraResponses: {
				...commonErrorResponses,
				'409': response('The slug already exists.', schemaRef('ErrorResponse')),
			},
		}),
		delete: contentOperation({
			operationId: 'deleteShortlink',
			summary: 'Delete a short link',
			description: 'Use ?id=<short-link-id>.',
			access: 'device-token',
			requiredAbility: 'delete Content',
			requiredScopes: ['shortlinks:manage'],
			scopeRequirements: 'PAT: shortlinks:manage is required.',
			parameters: [queryParameter('id', 'Short-link id.', undefined, true)],
			responseSchema: 'DeleteMessageResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/tags': {
		options: preflight('preflightTags'),
		get: contentOperation({
			operationId: 'getTags',
			summary: 'List tags',
			description:
				'Public tag definition list. No customer or response data is returned.',
			access: 'public',
			responseSchema: 'TagListResponse',
			extraResponses: { '500': commonErrorResponses['500'] },
		}),
		post: contentOperation({
			operationId: 'createTag',
			summary: 'Create a tag',
			description:
				'Creates a topic tag. id and timestamps are generated when omitted. Duplicate ids, names, or slugs return 409.',
			access: 'device-token',
			requiredAbility: 'create Content',
			requiredScopes: ['content:relations'],
			scopeRequirements: 'PAT: content:relations is required.',
			requestSchema: 'CreateTagRequest',
			responseSchema: 'TagResponse',
			successStatus: 201,
			extraResponses: {
				...commonErrorResponses,
				'409': response('The tag already exists.', schemaRef('ErrorResponse')),
			},
		}),
	},
	'/api/tags/attach': {
		options: preflight('preflightTagAttachment'),
		post: contentOperation({
			operationId: 'attachTag',
			summary: 'Attach a tag to a post',
			description:
				'Both the post and tag must already exist. PATs cannot attach tags to another resource type.',
			access: 'device-token',
			requiredAbility: 'update Content',
			requiredScopes: ['content:relations'],
			scopeRequirements: 'PAT: content:relations is required.',
			requestSchema: 'PostTagInput',
			responseSchema: 'PostTagMutationResponse',
			extraResponses: commonErrorResponses,
		}),
		delete: contentOperation({
			operationId: 'detachTag',
			summary: 'Detach a tag from a post',
			description:
				'Both the post and tag must already exist. PATs cannot detach tags from another resource type.',
			access: 'device-token',
			requiredAbility: 'update Content',
			requiredScopes: ['content:relations'],
			scopeRequirements: 'PAT: content:relations is required.',
			requestSchema: 'PostTagInput',
			responseSchema: 'PostTagMutationResponse',
			extraResponses: commonErrorResponses,
		}),
	},
	'/api/pages': {
		options: preflight('preflightPages'),
		get: contentOperation({
			operationId: 'getPages',
			summary: 'List or read pages',
			description:
				'Admin-only. Use ?slugOrId= for one page or omit it for all pages.',
			access: 'device-token',
			requiredAbility: 'manage all',
			parameters: [queryParameter('slugOrId', 'Optional page id or slug.')],
			responseSchema: 'PageReadResponse',
			extraResponses: commonErrorResponses,
		}),
		put: contentOperation({
			operationId: 'updatePage',
			summary: 'Update or publish a page',
			description:
				'Use ?id=<page-id>. Fields are merged. For PATs, content:write only updates an existing draft; publishing requires content:publish. Updating fields and publishing in one request requires both scopes. PATs cannot unpublish, archive, or delete pages. A title change does not regenerate the slug.',
			access: 'device-token',
			requiredAbility: 'update Content',
			requiredScopes: ['content:write', 'content:publish'],
			scopeRequirements:
				'PAT: content:write for draft field changes, content:publish when fields.state=published, and both when publishing together with other field changes.',
			parameters: [queryParameter('id', 'Page id.', undefined, true)],
			requestSchema: 'UpdatePageRequest',
			responseSchema: 'PageResponse',
			extraResponses: commonErrorResponses,
		}),
	},
}

const personalAccessTokenPaths = {
	'/api/personal-access-tokens': {
		options: preflight('preflightPersonalAccessTokens'),
		get: {
			tags: ['Agent tokens'],
			operationId: 'listPersonalAccessTokens',
			summary: 'List the caller’s agent tokens',
			description:
				'Admin-only. Returns safe metadata for tokens owned by the caller and never returns raw tokens or token hashes.',
			security: BEARER_SECURITY,
			'x-required-scopes': [],
			'x-required-ability': 'manage all',
			'x-agent-token-policy':
				'Scoped aih_pat_* tokens are excluded. Use an admin role-derived device token.',
			responses: {
				'200': response('Owned agent-token metadata.', {
					type: 'array',
					items: schemaRef('PersonalAccessToken'),
				}),
				...authErrorResponses,
				'500': commonErrorResponses['500'],
			},
		},
		post: {
			tags: ['Agent tokens'],
			operationId: 'mintPersonalAccessToken',
			summary: 'Mint a scoped agent token',
			description:
				'Admin-only and mint-for-self. The complete aih_pat_* token is returned exactly once.',
			security: BEARER_SECURITY,
			'x-required-scopes': [],
			'x-required-ability': 'manage all',
			'x-agent-token-policy':
				'Scoped aih_pat_* tokens are excluded. Use an admin role-derived device token.',
			requestBody: {
				required: true,
				content: jsonContent(schemaRef('MintPersonalAccessTokenRequest')),
			},
			responses: {
				'201': response(
					'Created. The token field is returned once and cannot be recovered later.',
					schemaRef('MintPersonalAccessTokenResponse'),
				),
				'400': commonErrorResponses['400'],
				...authErrorResponses,
				'503': response(
					'Personal access token hashing is not configured.',
					schemaRef('ErrorResponse'),
				),
				'500': commonErrorResponses['500'],
			},
		},
	},
	'/api/personal-access-tokens/{id}': {
		parameters: [
			pathParameter('id', 'Owned token id from the list operation.'),
		],
		delete: {
			tags: ['Agent tokens'],
			operationId: 'revokePersonalAccessToken',
			summary: 'Revoke an owned agent token',
			description:
				'Admin-only, owned-token-only, and idempotent. Revocation is the immediate kill switch.',
			security: BEARER_SECURITY,
			'x-required-scopes': [],
			'x-required-ability': 'manage all',
			'x-agent-token-policy':
				'Scoped aih_pat_* tokens are excluded. Use an admin role-derived device token.',
			responses: {
				'200': response(
					'Current token metadata with revokedAt set.',
					schemaRef('PersonalAccessToken'),
				),
				...authErrorResponses,
				'404': commonErrorResponses['404'],
				'500': commonErrorResponses['500'],
			},
		},
	},
}

const zodSchemas = {
	EmptyObjectResponse: EmptyObjectResponseSchema,
	ErrorResponse: ErrorResponseSchema,
	NextAction: NextActionSchema,
	CommandPreflightResult: CommandPreflightResultSchema,
	VideoResourceResponse: VideoResourceResponseSchema,
	SolutionCreateRequest: SolutionCreateRequestSchema,
	SolutionUpdateRequest: SolutionUpdateRequestSchema,
	SolutionResponse: SolutionResponseSchema,
	LessonUpdateRequest: LessonUpdateRequestSchema,
	LessonReadResponse: LessonReadResponseSchema,
	LessonResponse: LessonResponseSchema,
	PostCreateRequest: PostCreateRequestSchema,
	PostUpdateRequest: PostUpdateRequestSchema,
	PostReadResponse: PostReadResponseSchema,
	PostResponse: PostResponseSchema,
	DeleteMessageResponse: DeleteMessageResponseSchema,
	ProductCreateRequest: ProductCreateApiSchema,
	ProductUpdateRequest: ProductUpdateApiSchema,
	ProductReadResponse: ProductReadResponseSchema,
	ProductResponse: ProductResponseSchema,
	ProductAvailabilityResponse: ProductAvailabilityResponseSchema,
	ResourceCreateRequest: ResourceCreateRequestSchema,
	ResourceUpdateRequest: ResourceUpdateRequestSchema,
	ResourceReadResponse: ResourceReadResponseSchema,
	ResourceResponse: ResourceResponseSchema,
	SearchResult: SearchResultSchema,
	SkillChangelogRequest: SkillChangelogPostSchema,
	SkillChangelogResult: SkillChangelogResultSchema,
	CreateMultipartUploadRequest: CreateMultipartUploadSchema,
	CreateMultipartUploadResponse: CreateMultipartUploadResponseSchema,
	MultipartPartUrlResponse: MultipartPartUrlResponseSchema,
	CompleteMultipartUploadRequest: CompleteMultipartUploadSchema,
	CompleteMultipartUploadResponse: CompleteMultipartUploadResponseSchema,
	UploadRequest: UploadBodySchema,
	UploadStartedResponse: UploadStartedResponseSchema,
	SignedUploadUrlResponse: SignedUploadUrlResponseSchema,
	CreateShortlinkRequest: CreateShortlinkSchema,
	UpdateShortlinkRequest: UpdateShortlinkSchema,
	ShortlinkResponse: ShortlinkResponseSchema,
	ShortlinkReadResponse: ShortlinkReadResponseSchema,
	CreateTagRequest: CreateTagRequestSchema,
	TagResponse: TagResponseSchema,
	TagListResponse: TagListResponseSchema,
	PostTagInput: PostTagInputSchema,
	PostTagMutationResponse: PostTagMutationResponseSchema,
	AddListItemRequest: AddListItemRequestSchema,
	MoveListItemsRequest: MoveListItemsRequestSchema,
	ListItemRow: ListItemRowSchema,
	ListItemLocation: ListItemLocationSchema,
	MoveListItemsResult: MoveListItemsResultSchema,
	UpdatePageRequest: UpdatePageSchema,
	PageResponse: PageResponseSchema,
	PageReadResponse: PageReadResponseSchema,
	MintPersonalAccessTokenRequest: MintPersonalAccessTokenSchema,
	PersonalAccessToken: PersonalAccessTokenResponseSchema,
	MintPersonalAccessTokenResponse: MintPersonalAccessTokenResponseSchema,
} satisfies Record<string, ZodTypeAny>

/**
 * Detects the `z.union([z.string(), z.date()]).transform(v => new Date(v))`
 * shape this codebase uses for timestamps that arrive as strings.
 *
 * Zod models it as a `pipe` whose output is a `transform`, and a transform's
 * output type is opaque to the JSON Schema converter — under
 * `unrepresentable: 'any'` the field collapses to `{}`. The values are
 * serialized as ISO strings, so the pipe is described as a date-time string.
 *
 * @param def - The zod internal definition of the node being converted.
 * @returns True when the node is a transform pipe fed by a date.
 */
function isDateProducingPipe(def: any): boolean {
	if (def?.type !== 'pipe') return false
	if (def.out?._zod?.def?.type !== 'transform') return false

	const input = def.in?._zod?.def
	if (input?.type === 'date') return true
	if (input?.type === 'union') {
		return (input.options ?? []).some(
			(option: any) => option?._zod?.def?.type === 'date',
		)
	}
	return false
}

export function toOpenApiSchema(schema: ZodTypeAny): Record<string, unknown> {
	const converted = z.toJSONSchema(schema, {
		target: 'draft-2019-09',
		// Inline every subschema; the document must not lean on $defs/$ref.
		reused: 'inline',
		// Dates have no JSON Schema primitive, so zod refuses to guess. Emit the
		// date-time string form the API actually serializes.
		unrepresentable: 'any',
		override: (ctx) => {
			const def = ctx.zodSchema._zod.def
			if (def.type === 'date' || isDateProducingPipe(def)) {
				ctx.jsonSchema.type = 'string'
				ctx.jsonSchema.format = 'date-time'
			}
		},
	}) as Record<string, unknown>
	delete converted.$schema
	return converted
}

function buildComponentSchemas(): Record<string, any> {
	const generated = Object.fromEntries(
		Object.entries(zodSchemas).map(([name, schema]) => [
			name,
			toOpenApiSchema(schema),
		]),
	)

	return {
		...generated,
		CommandSuccessEnvelope: {
			type: 'object',
			description:
				'Shared success envelope for agent-oriented commands. result is operation-specific; next_actions contains executable discovery hints rather than hidden control flow.',
			required: ['ok', 'command', 'result', 'next_actions'],
			properties: {
				ok: { const: true },
				command: { type: 'string' },
				result: {
					oneOf: [
						schemaRef('SearchResult'),
						schemaRef('SkillChangelogResult'),
						schemaRef('CommandPreflightResult'),
					],
				},
				next_actions: {
					type: 'array',
					items: schemaRef('NextAction'),
				},
			},
		},
		CommandPreflightSuccessResponse: {
			allOf: [
				schemaRef('CommandSuccessEnvelope'),
				{
					type: 'object',
					properties: { result: schemaRef('CommandPreflightResult') },
				},
			],
			unevaluatedProperties: false,
		},
		SearchSuccessResponse: {
			allOf: [
				schemaRef('CommandSuccessEnvelope'),
				{
					type: 'object',
					properties: { result: schemaRef('SearchResult') },
				},
			],
			unevaluatedProperties: false,
		},
		SkillChangelogSuccessResponse: {
			description:
				'The canonical command envelope plus deprecated top-level id and slug compatibility fields. New clients should read result.resource.id and result.resource.fields.slug, or result.resourceId and result.slug in the defensive parse-failure result.',
			allOf: [
				schemaRef('CommandSuccessEnvelope'),
				{
					type: 'object',
					required: ['id', 'slug'],
					properties: {
						result: schemaRef('SkillChangelogResult'),
						id: {
							type: 'string',
							deprecated: true,
							description:
								'Deprecated compatibility mirror of result.resource.id or result.resourceId.',
						},
						slug: {
							type: 'string',
							deprecated: true,
							description:
								'Deprecated compatibility mirror of result.resource.fields.slug or result.slug.',
						},
					},
				},
			],
			unevaluatedProperties: false,
		},
	}
}

export function buildAgentOpenApiDocument(baseUrl: string) {
	const normalizedBaseUrl = baseUrl.replace(/\/$/, '')

	return {
		openapi: '3.1.0',
		// toOpenApiSchema targets 2019-09 syntax (array-form items for tuples),
		// so the advertised dialect must match what is actually generated.
		jsonSchemaDialect: 'https://json-schema.org/draft/2019-09/schema',
		info: {
			title: 'AI Hero Agent and Content API',
			version: '1.1.0',
			description:
				'Start at /api. Scoped aih_pat_* tokens may use content:read plus the narrow write scopes content:write, content:publish, content:relations, media:upload, and shortlinks:manage. On scoped write operations, x-required-scopes lists every PAT scope that can gate the operation and x-scope-requirements states the exact required combination or payload condition. Role-derived device tokens use x-required-ability instead. Customer data, purchases, surveys, survey responses, support memory, and agent-token administration remain outside PAT write access.',
		},
		servers: [{ url: normalizedBaseUrl }],
		tags: [
			{
				name: 'Agent tokens',
				description: 'Admin-only mint, list, and revoke operations.',
			},
			{
				name: 'Content API',
				description:
					'Public reads, PAT-backed reads and narrow writes, and role-derived device-token operations.',
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
						'Send Authorization: Bearer <token>. Scoped aih_pat_* tokens receive only scope-derived abilities; role-derived device tokens receive the current abilities of their user. Never put either token in a query string.',
				},
			},
			schemas: buildComponentSchemas(),
		},
	}
}
