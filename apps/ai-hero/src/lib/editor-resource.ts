import crypto from 'node:crypto'
import {
	publishedAtStamp,
	stripClientPublishedAt,
} from '@coursebuilder/ui/cms/resource-state'
import { guid } from '@coursebuilder/utils/guid'
import { z } from 'zod'

import { PageSchema } from './pages'
import { WorkshopFieldsSchema } from './workshops'

export const EDITOR_RESOURCE_TYPES = ['page', 'workshop'] as const
export type EditorResourceType = (typeof EDITOR_RESOURCE_TYPES)[number]

export const EditorResourceMutationRequestSchema = z
	.object({
		action: z.enum(['save', 'publish']).default('save'),
		fields: z.record(z.unknown()).default({}),
	})
	.strict()

export const EditorResourceRollbackRequestSchema = z
	.object({ versionId: z.string().min(1) })
	.strict()

export const EditorResourceSchema = z.object({
	id: z.string(),
	type: z.enum(EDITOR_RESOURCE_TYPES),
	fields: z.record(z.unknown()),
	currentVersionId: z.string().nullable(),
	createdAt: z.coerce.date().nullable(),
	updatedAt: z.coerce.date().nullable(),
})

export const EditorResourceResponseSchema = z.object({
	resource: EditorResourceSchema,
	revision: z.string(),
})

export const EditorResourceListResponseSchema = z.array(
	EditorResourceResponseSchema,
)

export const EditorResourceVersionSchema = z.object({
	id: z.string(),
	resourceId: z.string(),
	parentVersionId: z.string().nullable(),
	versionNumber: z.number().int().positive(),
	fields: z.record(z.unknown()),
	createdAt: z.coerce.date().nullable(),
	createdById: z.string(),
})

export const EditorResourceVersionListResponseSchema = z.array(
	EditorResourceVersionSchema,
)

export const EditorResourceMutationResponseSchema = z.object({
	resource: EditorResourceSchema,
	revision: z.string(),
	version: EditorResourceVersionSchema,
	baselineVersion: EditorResourceVersionSchema.nullable(),
})

export type EditorResourceMutationRequest = z.infer<
	typeof EditorResourceMutationRequestSchema
>

export type EditorContribution = {
	userId: string
	active: boolean
	deletedAt: Date | null
	contributionType: {
		slug: string
		active: boolean
		deletedAt: Date | null
	} | null
}

export type EditorResourceRecord = {
	id: string
	type: string
	createdById: string
	fields: Record<string, unknown> | null
	currentVersionId: string | null
	createdAt: Date | null
	updatedAt: Date | null
	deletedAt: Date | null
	organizationId: string | null
	createdByOrganizationMembershipId: string | null
	contributions: EditorContribution[]
}

export type EditorResourceVersion = z.infer<typeof EditorResourceVersionSchema>

export type EditorAccessContext = {
	userId: string
	isAdmin: boolean
}

export type VersionedMutationInput = EditorAccessContext & {
	resourceId: string
	expectedRevision: string
	fields?: Record<string, unknown>
	rollbackVersionId?: string
}

export type VersionedMutationResult = {
	previousResource: EditorResourceRecord
	resource: EditorResourceRecord
	version: EditorResourceVersion
	baselineVersion: EditorResourceVersion | null
}

export interface EditorResourceRepository {
	listCandidates(context: EditorAccessContext): Promise<EditorResourceRecord[]>
	getResource(resourceId: string): Promise<EditorResourceRecord | null>
	getVersion(
		resourceId: string,
		versionId: string,
	): Promise<EditorResourceVersion | null>
	listVersions(resourceId: string): Promise<EditorResourceVersion[]>
	commitVersionedMutation(
		input: VersionedMutationInput,
	): Promise<VersionedMutationResult>
}

export interface EditorResourceEffects {
	afterWrite(input: {
		action: 'save' | 'publish' | 'rollback'
		previousResource: EditorResourceRecord
		resource: EditorResourceRecord
		userId: string
	}): Promise<void>
}

export class EditorResourceError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409 | 422,
		readonly code:
			| 'conflict'
			| 'invalid-input'
			| 'not-found'
			| 'unsupported-resource',
	) {
		super(message)
		this.name = 'EditorResourceError'
	}
}

const supportedType = (type: string): type is EditorResourceType =>
	EDITOR_RESOURCE_TYPES.includes(type as EditorResourceType)

export function canAccessEditorResource(
	resource: EditorResourceRecord,
	context: EditorAccessContext,
) {
	if (resource.deletedAt) return false
	if (context.isAdmin || resource.createdById === context.userId) return true

	return resource.contributions.some(
		(contribution) =>
			contribution.userId === context.userId &&
			contribution.active &&
			!contribution.deletedAt &&
			contribution.contributionType?.slug === 'editor' &&
			contribution.contributionType.active &&
			!contribution.contributionType.deletedAt,
	)
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize)
	if (!value || typeof value !== 'object') return value

	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, canonicalize(nested)]),
	)
}

export function buildEditorResourceFieldsDigest(
	fields: Record<string, unknown>,
) {
	return crypto
		.createHash('sha256')
		.update(JSON.stringify(canonicalize(fields)))
		.digest('hex')
}

export function buildEditorResourceRevision(
	resource: Pick<
		EditorResourceRecord,
		'id' | 'currentVersionId' | 'fields' | 'updatedAt'
	>,
) {
	const state = JSON.stringify(
		canonicalize({
			id: resource.id,
			currentVersionId: resource.currentVersionId,
			fields: resource.fields ?? {},
			updatedAt: resource.updatedAt?.toISOString() ?? null,
		}),
	)
	return crypto.createHash('sha256').update(state).digest('hex')
}

export function createEditorResourceVersionId(resourceId: string) {
	const resourceHash = crypto
		.createHash('sha256')
		.update(resourceId)
		.digest('hex')
		.slice(0, 16)
	return `version~${resourceHash}~${guid()}`
}

export function formatEditorResourceEtag(revision: string) {
	return `"${revision}"`
}

export function parseEditorResourceEtag(value: string | null) {
	if (!value) return null
	const trimmed = value.trim()
	if (trimmed.startsWith('W/')) return null
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

function publicResource(resource: EditorResourceRecord) {
	if (!supportedType(resource.type)) {
		throw new EditorResourceError(
			`Resource type ${resource.type} is not supported by the editor API`,
			422,
			'unsupported-resource',
		)
	}

	return {
		id: resource.id,
		type: resource.type,
		fields: resource.fields ?? {},
		currentVersionId: resource.currentVersionId,
		createdAt: resource.createdAt,
		updatedAt: resource.updatedAt,
	}
}

function responseResource(resource: EditorResourceRecord) {
	return {
		resource: publicResource(resource),
		revision: buildEditorResourceRevision(resource),
	}
}

function assertValidResourceFields(
	resource: EditorResourceRecord,
	candidate: Record<string, unknown>,
) {
	const parsed =
		resource.type === 'workshop'
			? WorkshopFieldsSchema.safeParse(candidate)
			: resource.type === 'page'
				? PageSchema.shape.fields.safeParse(candidate)
				: null

	if (!parsed) {
		throw new EditorResourceError(
			`Resource type ${resource.type} is not supported by the editor API`,
			422,
			'unsupported-resource',
		)
	}
	if (!parsed.success) {
		throw new EditorResourceError(
			`Invalid ${resource.type} fields: ${parsed.error.issues
				.map((issue) => issue.message)
				.join(', ')}`,
			400,
			'invalid-input',
		)
	}
}

function validateCandidateFields(
	resource: EditorResourceRecord,
	request: EditorResourceMutationRequest,
) {
	if ('state' in request.fields) {
		throw new EditorResourceError(
			'Use action=publish for state changes',
			400,
			'invalid-input',
		)
	}

	const currentFields = resource.fields ?? {}
	const incomingFields = stripClientPublishedAt(request.fields)
	const currentState = currentFields.state
	if (currentState === 'archived' || currentState === 'deleted') {
		throw new EditorResourceError(
			'Archived or deleted resources cannot be edited through this API',
			422,
			'unsupported-resource',
		)
	}

	const nextState =
		request.action === 'publish' ? 'published' : (currentState ?? 'draft')
	const candidate = {
		...currentFields,
		...incomingFields,
		...(nextState ? { state: nextState } : {}),
		...publishedAtStamp(nextState, currentFields),
	}
	assertValidResourceFields(resource, candidate)
	return candidate
}

export function createEditorResourceService(
	repository: EditorResourceRepository,
	effects: EditorResourceEffects,
) {
	const findAuthorized = async (
		resourceId: string,
		context: EditorAccessContext,
	) => {
		const resource = await repository.getResource(resourceId)
		if (!resource || !canAccessEditorResource(resource, context)) {
			throw new EditorResourceError('Resource not found', 404, 'not-found')
		}
		if (!supportedType(resource.type)) {
			throw new EditorResourceError(
				`Resource type ${resource.type} is not supported by the editor API`,
				422,
				'unsupported-resource',
			)
		}
		return resource
	}

	return {
		async list(context: EditorAccessContext) {
			const resources = await repository.listCandidates(context)
			return resources
				.filter(
					(resource) =>
						supportedType(resource.type) &&
						canAccessEditorResource(resource, context),
				)
				.map(responseResource)
		},

		async get(resourceId: string, context: EditorAccessContext) {
			return responseResource(await findAuthorized(resourceId, context))
		},

		async listVersions(resourceId: string, context: EditorAccessContext) {
			await findAuthorized(resourceId, context)
			return repository.listVersions(resourceId)
		},

		async update(
			resourceId: string,
			request: EditorResourceMutationRequest,
			expectedRevision: string,
			context: EditorAccessContext,
		) {
			const current = await findAuthorized(resourceId, context)
			const fields = validateCandidateFields(current, request)
			const result = await repository.commitVersionedMutation({
				...context,
				resourceId,
				expectedRevision,
				fields,
			})

			await effects.afterWrite({
				action: request.action,
				previousResource: result.previousResource,
				resource: result.resource,
				userId: context.userId,
			})

			return {
				...responseResource(result.resource),
				version: result.version,
				baselineVersion: result.baselineVersion,
			}
		},

		async rollback(
			resourceId: string,
			versionId: string,
			expectedRevision: string,
			context: EditorAccessContext,
		) {
			const current = await findAuthorized(resourceId, context)
			const selected = await repository.getVersion(resourceId, versionId)
			if (!selected) {
				throw new EditorResourceError('Version not found', 404, 'not-found')
			}
			if (
				selected.fields.state !== 'draft' &&
				selected.fields.state !== 'published'
			) {
				throw new EditorResourceError(
					'Only draft or published versions can be restored',
					422,
					'unsupported-resource',
				)
			}
			assertValidResourceFields(current, selected.fields)

			const result = await repository.commitVersionedMutation({
				...context,
				resourceId,
				expectedRevision,
				fields: selected.fields,
				rollbackVersionId: versionId,
			})

			await effects.afterWrite({
				action: 'rollback',
				previousResource: result.previousResource,
				resource: result.resource,
				userId: context.userId,
			})

			return {
				...responseResource(result.resource),
				version: result.version,
				baselineVersion: result.baselineVersion,
			}
		},
	}
}

export type EditorResourceService = ReturnType<
	typeof createEditorResourceService
>
