import { db } from '@/db'
import {
	contentContributions,
	contentResource,
	contentResourceVersion,
	contributionTypes,
} from '@/db/schema'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'

import {
	buildEditorResourceFieldsDigest,
	buildEditorResourceRevision,
	canAccessEditorResource,
	createEditorResourceService,
	createEditorResourceVersionId,
	EDITOR_RESOURCE_TYPES,
	EditorResourceError,
	type EditorContribution,
	type EditorResourceRecord,
	type EditorResourceRepository,
	type EditorResourceVersion,
} from './editor-resource'
import { editorResourceEffects } from './editor-resource-effects'

type ContributionRow = typeof contentContributions.$inferSelect & {
	contributionType: typeof contributionTypes.$inferSelect | null
}

type ResourceRow = typeof contentResource.$inferSelect & {
	contributions: ContributionRow[]
}

function normalizeContribution(row: ContributionRow): EditorContribution {
	return {
		userId: row.userId,
		active: row.active,
		deletedAt: row.deletedAt,
		contributionType: row.contributionType
			? {
					slug: row.contributionType.slug,
					active: row.contributionType.active,
					deletedAt: row.contributionType.deletedAt,
				}
			: null,
	}
}

function normalizeResource(row: ResourceRow): EditorResourceRecord {
	return {
		id: row.id,
		type: row.type,
		createdById: row.createdById,
		fields: row.fields ?? {},
		currentVersionId: row.currentVersionId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		deletedAt: row.deletedAt,
		organizationId: row.organizationId,
		createdByOrganizationMembershipId: row.createdByOrganizationMembershipId,
		contributions: row.contributions.map(normalizeContribution),
	}
}

function normalizeVersion(
	row: typeof contentResourceVersion.$inferSelect,
): EditorResourceVersion {
	return {
		id: row.id,
		resourceId: row.resourceId,
		parentVersionId: row.parentVersionId,
		versionNumber: row.versionNumber,
		fields: row.fields ?? {},
		createdAt: row.createdAt,
		createdById: row.createdById,
	}
}

function affectedRows(result: unknown) {
	if (!result || typeof result !== 'object') return 0
	const record = result as Record<string, unknown>
	if (typeof record.rowsAffected === 'number') return record.rowsAffected
	if (typeof record.affectedRows === 'number') return record.affectedRows
	return 0
}

const withContributions = {
	contributions: { with: { contributionType: true } },
} as const

export const editorResourceRepository: EditorResourceRepository = {
	async listCandidates(context) {
		let allowedResourceIds: string[] = []
		if (!context.isAdmin) {
			const contributions = await db.query.contentContributions.findMany({
				where: and(
					eq(contentContributions.userId, context.userId),
					eq(contentContributions.active, true),
					isNull(contentContributions.deletedAt),
				),
				with: { contributionType: true },
			})
			allowedResourceIds = contributions
				.filter(
					(row) =>
						row.contributionType?.slug === 'editor' &&
						row.contributionType.active &&
						!row.contributionType.deletedAt,
				)
				.map((row) => row.contentId)
		}

		const ownership = context.isAdmin
			? undefined
			: allowedResourceIds.length
				? or(
						eq(contentResource.createdById, context.userId),
						inArray(contentResource.id, allowedResourceIds),
					)
				: eq(contentResource.createdById, context.userId)

		const rows = await db.query.contentResource.findMany({
			where: and(
				inArray(contentResource.type, [...EDITOR_RESOURCE_TYPES]),
				isNull(contentResource.deletedAt),
				ownership,
			),
			with: withContributions,
			orderBy: desc(contentResource.updatedAt),
		})

		return rows.map(normalizeResource)
	},

	async getResource(resourceId) {
		const row = await db.query.contentResource.findFirst({
			where: eq(contentResource.id, resourceId),
			with: withContributions,
		})
		return row ? normalizeResource(row) : null
	},

	async getVersion(resourceId, versionId) {
		const row = await db.query.contentResourceVersion.findFirst({
			where: and(
				eq(contentResourceVersion.resourceId, resourceId),
				eq(contentResourceVersion.id, versionId),
			),
		})
		return row ? normalizeVersion(row) : null
	},

	async listVersions(resourceId) {
		const rows = await db.query.contentResourceVersion.findMany({
			where: eq(contentResourceVersion.resourceId, resourceId),
			orderBy: desc(contentResourceVersion.versionNumber),
		})
		return rows.map(normalizeVersion)
	},

	async commitVersionedMutation(input) {
		return db.transaction(async (tx) => {
			// Lock the resource before reading its revision. The conditional update
			// below remains the compare-and-swap backstop, but this lock serializes
			// competing editor writes inside MySQL instead of letting both allocate
			// the same next version number.
			const lockedResource = await tx
				.select()
				.from(contentResource)
				.where(eq(contentResource.id, input.resourceId))
				.for('update')
				.then((rows) => rows[0] ?? null)
			if (!lockedResource) {
				throw new EditorResourceError('Resource not found', 404, 'not-found')
			}

			// Lock and re-check the concrete grant in the same transaction. Revoking
			// the contribution or contribution type cannot race a write already
			// past authorization.
			const lockedContributions = await tx
				.select({
					contribution: contentContributions,
					contributionType: contributionTypes,
				})
				.from(contentContributions)
				.innerJoin(
					contributionTypes,
					eq(contentContributions.contributionTypeId, contributionTypes.id),
				)
				.where(eq(contentContributions.contentId, input.resourceId))
				.for('update')
			const current = normalizeResource({
				...lockedResource,
				contributions: lockedContributions.map(
					({ contribution, contributionType }) => ({
						...contribution,
						contributionType,
					}),
				),
			})
			if (!canAccessEditorResource(current, input)) {
				throw new EditorResourceError('Resource not found', 404, 'not-found')
			}

			const currentRevision = buildEditorResourceRevision(current)
			if (currentRevision !== input.expectedRevision) {
				throw new EditorResourceError(
					'The resource changed after it was read',
					409,
					'conflict',
				)
			}

			let candidateFields = input.fields
			if (input.rollbackVersionId) {
				const selected = await tx.query.contentResourceVersion.findFirst({
					where: and(
						eq(contentResourceVersion.resourceId, input.resourceId),
						eq(contentResourceVersion.id, input.rollbackVersionId),
					),
				})
				if (!selected) {
					throw new EditorResourceError('Version not found', 404, 'not-found')
				}
				const selectedFields = selected.fields ?? {}
				if (
					!input.fields ||
					buildEditorResourceFieldsDigest(input.fields) !==
						buildEditorResourceFieldsDigest(selectedFields)
				) {
					throw new EditorResourceError(
						'The selected version changed before rollback',
						409,
						'conflict',
					)
				}
				candidateFields = selectedFields
			}
			if (!candidateFields) {
				throw new EditorResourceError(
					'Mutation fields are required',
					400,
					'invalid-input',
				)
			}

			const latestVersion = await tx.query.contentResourceVersion.findFirst({
				where: eq(contentResourceVersion.resourceId, input.resourceId),
				orderBy: desc(contentResourceVersion.versionNumber),
			})
			const firstVersionNumber = (latestVersion?.versionNumber ?? 0) + 1
			const now = new Date()
			const baselineVersion = current.currentVersionId
				? null
				: {
						id: createEditorResourceVersionId(current.id),
						resourceId: current.id,
						parentVersionId: null,
						versionNumber: firstVersionNumber,
						fields: current.fields ?? {},
						createdAt: now,
						createdById: input.userId,
					}
			const version: EditorResourceVersion = {
				id: createEditorResourceVersionId(current.id),
				resourceId: current.id,
				parentVersionId: baselineVersion?.id ?? current.currentVersionId,
				versionNumber: firstVersionNumber + (baselineVersion ? 1 : 0),
				fields: candidateFields,
				createdAt: now,
				createdById: input.userId,
			}

			const pointerCondition = current.currentVersionId
				? eq(contentResource.currentVersionId, current.currentVersionId)
				: isNull(contentResource.currentVersionId)
			const timestampCondition = current.updatedAt
				? eq(contentResource.updatedAt, current.updatedAt)
				: isNull(contentResource.updatedAt)
			const update = await tx
				.update(contentResource)
				.set({
					fields: candidateFields,
					currentVersionId: version.id,
					updatedAt: now,
				})
				.where(
					and(
						eq(contentResource.id, current.id),
						pointerCondition,
						timestampCondition,
					),
				)

			if (affectedRows(update) !== 1) {
				throw new EditorResourceError(
					'The resource changed after it was read',
					409,
					'conflict',
				)
			}

			if (baselineVersion) {
				await tx.insert(contentResourceVersion).values({
					...baselineVersion,
					organizationId: current.organizationId,
				})
			}
			await tx.insert(contentResourceVersion).values({
				...version,
				organizationId: current.organizationId,
			})

			return {
				previousResource: current,
				resource: {
					...current,
					fields: candidateFields,
					currentVersionId: version.id,
					updatedAt: now,
				},
				version,
				baselineVersion,
			}
		})
	},
}

export const editorResourceService = createEditorResourceService(
	editorResourceRepository,
	editorResourceEffects,
)
