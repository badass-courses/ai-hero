import { db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	contentResourceResource,
	contentResourceVersion,
	courseSyncBinding,
	courseSyncRun,
	courseSyncRunResourceVersion,
	courseSyncSourceRevision,
	courseSyncSourceRevisionAsset,
	products,
} from '@/db/schema'
import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm'

import { CourseSyncError } from './errors'
import { sha256, stableJson } from './control-plane'
import {
	assertManagedChildRelations,
	chunkCourseSyncWrites,
} from './persistence-invariants'
import type {
	CourseSyncBinding,
	CourseSyncPersistence,
	FrozenSourceAsset,
	SourceRevisionRecord,
	SyncPlan,
	SyncRunRecord,
	TargetResourceSnapshot,
} from './types'

function runFromRow(row: typeof courseSyncRun.$inferSelect): SyncRunRecord {
	return {
		runId: row.runId,
		bindingId: row.bindingId,
		sourceRevisionId: row.sourceRevisionId,
		courseVersionId: row.courseVersionId,
		state: row.state as SyncRunRecord['state'],
		stageIdempotencyKey: row.stageIdempotencyKey,
		stageFingerprint: row.stageFingerprint,
		applyIdempotencyKey: row.applyIdempotencyKey,
		rollbackOfRunId: row.rollbackOfRunId,
		compensatingRunId: row.compensatingRunId,
		plan: row.plan,
		planSha256: row.planSha256,
		failureCode: row.failureCode,
		failureReason: row.failureReason,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

function bindingFromRow(
	row: typeof courseSyncBinding.$inferSelect,
): CourseSyncBinding {
	return row.binding
}

function exactBinding(actual: CourseSyncBinding, expected: CourseSyncBinding) {
	return stableJson(actual) === stableJson(expected)
}

async function readRun(runId: string): Promise<SyncRunRecord | null> {
	const row = await db.query.courseSyncRun.findFirst({
		where: eq(courseSyncRun.runId, runId),
	})
	return row ? runFromRow(row) : null
}

export const drizzleCourseSyncPersistence: CourseSyncPersistence = {
	async ensureBinding(binding) {
		const existing = await db.query.courseSyncBinding.findFirst({
			where: eq(courseSyncBinding.bindingId, binding.bindingId),
		})
		if (existing) {
			if (!exactBinding(existing.binding, binding)) {
				throw new CourseSyncError(
					'IMMUTABLE_BINDING_CONFLICT',
					'The stored sync binding does not match the server-owned binding.',
					409,
				)
			}
			return bindingFromRow(existing)
		}
		await db.insert(courseSyncBinding).values({
			bindingId: binding.bindingId,
			sourceCourseId: binding.sourceCourseId,
			productId: binding.productId,
			anchorWorkshopId: binding.anchorWorkshopId,
			status: binding.status,
			binding,
		})
		return binding
	},

	async getBinding(bindingId) {
		const row = await db.query.courseSyncBinding.findFirst({
			where: eq(courseSyncBinding.bindingId, bindingId),
		})
		return row ? bindingFromRow(row) : null
	},

	async assertTarget(binding) {
		const [product, workshop, relation, otherProductRelations, childRelations] =
			await Promise.all([
				db.query.products.findFirst({
					where: eq(products.id, binding.productId),
				}),
				db.query.contentResource.findFirst({
					where: eq(contentResource.id, binding.anchorWorkshopId),
				}),
				db.query.contentResourceProduct.findFirst({
					where: and(
						eq(contentResourceProduct.productId, binding.productId),
						eq(contentResourceProduct.resourceId, binding.anchorWorkshopId),
						isNull(contentResourceProduct.deletedAt),
					),
				}),
				db.query.contentResourceProduct.findMany({
					where: and(
						eq(contentResourceProduct.resourceId, binding.anchorWorkshopId),
						ne(contentResourceProduct.productId, binding.productId),
						isNull(contentResourceProduct.deletedAt),
					),
				}),
				db.query.contentResourceResource.findMany({
					where: and(
						eq(contentResourceResource.resourceOfId, binding.anchorWorkshopId),
						isNull(contentResourceResource.deletedAt),
					),
					with: { resource: true },
				}),
			])
		const productFields = product?.fields as Record<string, unknown> | undefined
		const workshopFields = workshop?.fields as
			| Record<string, unknown>
			| undefined
		if (
			!product ||
			product.type !== binding.productType ||
			productFields?.state !== binding.requiredState ||
			productFields.visibility !== binding.requiredVisibility
		) {
			throw new CourseSyncError(
				'TARGET_PRODUCT_ASSERTION_FAILED',
				'The bound product is missing or is not the required self-paced draft/unlisted target.',
				409,
			)
		}
		if (
			!workshop ||
			workshop.deletedAt ||
			workshop.type !== 'workshop' ||
			workshopFields?.state !== binding.requiredState ||
			workshopFields.visibility !== binding.requiredVisibility
		) {
			throw new CourseSyncError(
				'TARGET_WORKSHOP_ASSERTION_FAILED',
				'The bound workshop is missing or is not draft/unlisted.',
				409,
			)
		}
		if (
			!relation ||
			relation.position !== 0 ||
			otherProductRelations.length > 0
		) {
			throw new CourseSyncError(
				'TARGET_RELATION_ASSERTION_FAILED',
				'The bound product/workshop relation is missing, moved, deleted, or widened.',
				409,
			)
		}
		assertManagedChildRelations(binding, childRelations)
	},

	async findRunByStageKey(bindingId, key) {
		const row = await db.query.courseSyncRun.findFirst({
			where: and(
				eq(courseSyncRun.bindingId, bindingId),
				eq(courseSyncRun.stageIdempotencyKey, key),
			),
		})
		return row ? runFromRow(row) : null
	},

	async findAppliedRunByRevision(bindingId, courseVersionId) {
		const row = await db.query.courseSyncRun.findFirst({
			where: and(
				eq(courseSyncRun.bindingId, bindingId),
				eq(courseSyncRun.courseVersionId, courseVersionId),
				eq(courseSyncRun.state, 'applied'),
				isNull(courseSyncRun.rollbackOfRunId),
			),
			orderBy: desc(courseSyncRun.updatedAt),
		})
		return row ? runFromRow(row) : null
	},

	async createStaged({ revision, run }) {
		await db.transaction(async (trx) => {
			await trx.insert(courseSyncSourceRevision).values({
				sourceRevisionId: revision.sourceRevisionId,
				bindingId: revision.bindingId,
				courseVersionId: revision.courseVersionId,
				providerRevision: revision.providerRevision,
				manifestSha256: revision.manifestSha256,
				manifestSnapshotUri: revision.manifestSnapshotUri,
				manifest: revision.manifest as unknown as Record<string, unknown>,
				stagedAt: revision.stagedAt,
			})
			await trx.insert(courseSyncSourceRevisionAsset).values(
				revision.assets.map((asset) => ({
					sourceRevisionId: revision.sourceRevisionId,
					...asset,
				})),
			)
			await trx.insert(courseSyncRun).values(run)
		})
		return run
	},

	getRun: readRun,

	async getRevision(sourceRevisionId) {
		const [revision, assets] = await Promise.all([
			db.query.courseSyncSourceRevision.findFirst({
				where: eq(courseSyncSourceRevision.sourceRevisionId, sourceRevisionId),
			}),
			db.query.courseSyncSourceRevisionAsset.findMany({
				where: eq(
					courseSyncSourceRevisionAsset.sourceRevisionId,
					sourceRevisionId,
				),
				orderBy: asc(courseSyncSourceRevisionAsset.sourceVideoId),
			}),
		])
		if (!revision) return null
		return {
			sourceRevisionId: revision.sourceRevisionId,
			bindingId: revision.bindingId,
			courseVersionId: revision.courseVersionId,
			providerRevision: revision.providerRevision,
			manifestSha256: revision.manifestSha256,
			manifestSnapshotUri: revision.manifestSnapshotUri,
			manifest: revision.manifest as SourceRevisionRecord['manifest'],
			assets: assets as ReadonlyArray<FrozenSourceAsset>,
			stagedAt: revision.stagedAt,
		}
	},

	async getLastAppliedRun(bindingId) {
		const row = await db.query.courseSyncRun.findFirst({
			where: and(
				eq(courseSyncRun.bindingId, bindingId),
				eq(courseSyncRun.state, 'applied'),
				isNull(courseSyncRun.rollbackOfRunId),
			),
			orderBy: desc(courseSyncRun.updatedAt),
		})
		return row ? runFromRow(row) : null
	},

	async getTargetResources(resourceIds) {
		if (resourceIds.length === 0) return new Map()
		const rows = await db
			.select({
				resourceId: contentResource.id,
				currentVersionId: contentResource.currentVersionId,
				fields: contentResource.fields,
			})
			.from(contentResource)
			.where(inArray(contentResource.id, [...resourceIds]))
		return new Map(
			rows.map((row) => [
				row.resourceId,
				{
					resourceId: row.resourceId,
					currentVersionId: row.currentVersionId,
					fields: row.fields ?? {},
				} satisfies TargetResourceSnapshot,
			]),
		)
	},

	async savePreview(runId, plan) {
		await db
			.update(courseSyncRun)
			.set({
				state: 'previewed',
				plan,
				planSha256: plan.planSha256,
				updatedAt: new Date(),
			})
			.where(
				and(eq(courseSyncRun.runId, runId), eq(courseSyncRun.state, 'staged')),
			)
		const run = await readRun(runId)
		if (!run || run.state !== 'previewed') {
			throw new CourseSyncError(
				'PREVIEW_CONCURRENCY_CONFLICT',
				'The run changed while previewing.',
				409,
			)
		}
		return run
	},

	async applyAtomically({ runId, plan, idempotencyKey, createdById }) {
		await db.transaction(async (trx) => {
			const row = await trx.query.courseSyncRun.findFirst({
				where: eq(courseSyncRun.runId, runId),
			})
			if (
				!row ||
				(row.state !== 'previewed' && row.state !== 'failed') ||
				row.planSha256 !== plan.planSha256
			) {
				throw new CourseSyncError(
					'APPLY_CONCURRENCY_CONFLICT',
					'The run or content-addressed plan changed before apply.',
					409,
				)
			}
			if (
				row.state === 'failed' &&
				row.applyIdempotencyKey &&
				row.applyIdempotencyKey !== idempotencyKey
			) {
				throw new CourseSyncError(
					'IDEMPOTENCY_CONFLICT',
					'Failed apply retry used another idempotency key.',
					409,
				)
			}

			const priorReceipts = await trx
				.select({ resourceId: courseSyncRunResourceVersion.resourceId })
				.from(courseSyncRunResourceVersion)
				.where(eq(courseSyncRunResourceVersion.runId, runId))
			if (priorReceipts.length > 0) {
				throw new CourseSyncError(
					'FAILED_APPLY_NOT_ROLLED_BACK',
					'A failed apply retained resource receipts and cannot be retried.',
					409,
				)
			}

			const resourceIds = plan.resources.map((item) => item.targetResourceId)
			const existingRows = await trx
				.select({
					id: contentResource.id,
					type: contentResource.type,
					currentVersionId: contentResource.currentVersionId,
					fields: contentResource.fields,
				})
				.from(contentResource)
				.where(inArray(contentResource.id, resourceIds))
			const existingById = new Map(existingRows.map((item) => [item.id, item]))
			const relationRows = await trx
				.select({
					resourceOfId: contentResourceResource.resourceOfId,
					resourceId: contentResourceResource.resourceId,
					position: contentResourceResource.position,
					deletedAt: contentResourceResource.deletedAt,
				})
				.from(contentResourceResource)
				.where(inArray(contentResourceResource.resourceId, resourceIds))
			const relationsByResource = new Map<
				string,
				Array<(typeof relationRows)[number]>
			>()
			for (const relation of relationRows) {
				const relations = relationsByResource.get(relation.resourceId) ?? []
				relations.push(relation)
				relationsByResource.set(relation.resourceId, relations)
			}
			const latestVersions = await trx
				.select({
					resourceId: contentResourceVersion.resourceId,
					versionNumber: max(contentResourceVersion.versionNumber),
				})
				.from(contentResourceVersion)
				.where(inArray(contentResourceVersion.resourceId, resourceIds))
				.groupBy(contentResourceVersion.resourceId)
			const latestVersionByResource = new Map(
				latestVersions.map((item) => [
					item.resourceId,
					Number(item.versionNumber ?? 0),
				]),
			)

			const newResources: Array<typeof contentResource.$inferInsert> = []
			const versions: Array<typeof contentResourceVersion.$inferInsert> = []
			const receipts: Array<typeof courseSyncRunResourceVersion.$inferInsert> = []
			const relationPromotions: Array<
				typeof contentResourceResource.$inferInsert
			> = []
			const pointerPromotions: Array<typeof contentResource.$inferInsert> = []

			for (const item of plan.resources) {
				const existing = existingById.get(item.targetResourceId)
				if (item.action === 'create') {
					if (existing) {
						throw new CourseSyncError(
							'RESOURCE_ALREADY_EXISTS',
							'A planned resource ID already exists.',
							409,
						)
					}
					if ((relationsByResource.get(item.targetResourceId) ?? []).length > 0) {
						throw new CourseSyncError(
							'ORPHAN_RELATION_CONFLICT',
							'A create target already has a relation, including a tombstone.',
							409,
						)
					}
					newResources.push({
						id: item.targetResourceId,
						type: item.sourceKind,
						createdById,
						fields: item.fields,
						currentVersionId: null,
					})
				} else {
					if (!existing) {
						throw new CourseSyncError(
							'MANAGED_RESOURCE_MISSING',
							'A managed target resource disappeared.',
							409,
						)
					}
					const fields = existing.fields as Record<string, unknown>
					const sync = fields.courseSync as Record<string, unknown> | undefined
					if (
						existing.type !== item.sourceKind ||
						fields.state !== 'draft' ||
						fields.visibility !== 'unlisted' ||
						sync?.bindingId !== plan.bindingId
					) {
						throw new CourseSyncError(
							'MANAGED_RESOURCE_SCOPE_MISMATCH',
							'A managed resource left draft sync scope.',
							409,
						)
					}
					if (existing.currentVersionId !== item.previousVersionId) {
						throw new CourseSyncError(
							'APPLY_TARGET_CHANGED',
							'A managed resource pointer changed after preview.',
							409,
						)
					}
					const relations = (
						relationsByResource.get(item.targetResourceId) ?? []
					).filter((relation) => relation.deletedAt === null)
					if (
						relations.length !== 1 ||
						relations[0]?.resourceOfId !== item.parentResourceId
					) {
						throw new CourseSyncError(
							'MANAGED_RELATION_MISSING',
							'The managed relation changed after preview.',
							409,
						)
					}
				}

				const parentVersionId = existing?.currentVersionId ?? null
				let contentResourceVersionId = parentVersionId
				if (item.action !== 'retain') {
					contentResourceVersionId = `version~${sha256(
						stableJson({
							runId,
							resourceId: item.targetResourceId,
							fields: item.fields,
						}),
					)}`
					versions.push({
						id: contentResourceVersionId,
						resourceId: item.targetResourceId,
						parentVersionId,
						versionNumber:
							(latestVersionByResource.get(item.targetResourceId) ?? 0) + 1,
						fields: item.fields,
						createdById,
					})
					pointerPromotions.push({
						id: item.targetResourceId,
						type: item.sourceKind,
						createdById,
						fields: item.fields,
						currentVersionId: contentResourceVersionId,
					})
				} else if (!contentResourceVersionId) {
					throw new CourseSyncError(
						'RETAINED_VERSION_MISSING',
						'A retained resource has no current version.',
						409,
					)
				}
				receipts.push({
					runId,
					resourceId: item.targetResourceId,
					contentResourceVersionId,
					parentVersionId,
					previousParentResourceId: item.previousParentResourceId,
					previousPosition: item.previousPosition,
					action: item.action,
				})
				relationPromotions.push({
					resourceOfId: item.parentResourceId,
					resourceId: item.targetResourceId,
					position: item.position,
					metadata: { bindingId: plan.bindingId, sourceId: item.sourceId },
					deletedAt: null,
				})
			}

			await trx
				.update(courseSyncRun)
				.set({
					state: 'applying',
					applyIdempotencyKey: idempotencyKey,
					failureCode: null,
					failureReason: null,
					updatedAt: new Date(),
				})
				.where(eq(courseSyncRun.runId, runId))

			for (const batch of chunkCourseSyncWrites(newResources)) {
				await trx.insert(contentResource).values(batch)
			}
			for (const batch of chunkCourseSyncWrites(versions)) {
				await trx.insert(contentResourceVersion).values(batch)
			}
			for (const batch of chunkCourseSyncWrites(receipts)) {
				await trx.insert(courseSyncRunResourceVersion).values(batch)
			}

			const preparedResources = await trx
				.select({ id: contentResource.id })
				.from(contentResource)
				.where(inArray(contentResource.id, resourceIds))
			const preparedVersions =
				versions.length === 0
					? []
					: await trx
							.select({ id: contentResourceVersion.id })
							.from(contentResourceVersion)
							.where(
								inArray(
									contentResourceVersion.id,
									versions.map((version) => version.id),
								),
							)
			const preparedReceipts = await trx
				.select({ resourceId: courseSyncRunResourceVersion.resourceId })
				.from(courseSyncRunResourceVersion)
				.where(eq(courseSyncRunResourceVersion.runId, runId))
			if (
				preparedResources.length !== plan.resources.length ||
				preparedVersions.length !== versions.length ||
				preparedReceipts.length !== plan.resources.length
			) {
				throw new CourseSyncError(
					'APPLY_PREPARATION_COUNT_MISMATCH',
					'Prepared apply rows do not match the content-addressed plan.',
					500,
				)
			}

			// Relations and current-version pointers are the activation boundary. These
			// batched upserts and the applied state commit together or all roll back.
			for (const batch of chunkCourseSyncWrites(relationPromotions)) {
				await trx
					.insert(contentResourceResource)
					.values(batch)
					.onDuplicateKeyUpdate({
						set: {
							position: sql`values(${contentResourceResource.position})`,
							metadata: sql`values(${contentResourceResource.metadata})`,
							deletedAt: null,
							updatedAt: new Date(),
						},
					})
			}
			for (const batch of chunkCourseSyncWrites(pointerPromotions)) {
				await trx
					.insert(contentResource)
					.values(batch)
					.onDuplicateKeyUpdate({
						set: {
							currentVersionId: sql`values(${contentResource.currentVersionId})`,
							fields: sql`values(${contentResource.fields})`,
							updatedAt: new Date(),
						},
					})
			}
			await trx
				.update(courseSyncRun)
				.set({ state: 'applied', updatedAt: new Date() })
				.where(eq(courseSyncRun.runId, runId))
		})
		const applied = await readRun(runId)
		if (!applied)
			throw new CourseSyncError(
				'RUN_NOT_FOUND',
				'Applied run disappeared.',
				500,
			)
		return applied
	},

	async markFailed(runId, code, reason, applyIdempotencyKey) {
		await db
			.update(courseSyncRun)
			.set({
				state: 'failed',
				applyIdempotencyKey,
				failureCode: code,
				failureReason: reason,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(courseSyncRun.runId, runId),
					ne(courseSyncRun.state, 'applied'),
				),
			)
		const failed = await readRun(runId)
		if (!failed)
			throw new CourseSyncError('RUN_NOT_FOUND', 'Failed run disappeared.', 500)
		return failed
	},

	async rollbackAtomically({
		runId,
		idempotencyKey,
		compensatingRunId,
		createdById,
	}) {
		await db.transaction(async (trx) => {
			const original = await trx.query.courseSyncRun.findFirst({
				where: eq(courseSyncRun.runId, runId),
			})
			if (!original || original.state !== 'applied') {
				throw new CourseSyncError(
					'ROLLBACK_CONCURRENCY_CONFLICT',
					'The run is no longer applied.',
					409,
				)
			}
			const receipts = await trx.query.courseSyncRunResourceVersion.findMany({
				where: eq(courseSyncRunResourceVersion.runId, runId),
			})
			const now = new Date()
			await trx.insert(courseSyncRun).values({
				runId: compensatingRunId,
				bindingId: original.bindingId,
				sourceRevisionId: original.sourceRevisionId,
				courseVersionId: original.courseVersionId,
				state: 'applying',
				stageIdempotencyKey: `rollback:${runId}:${idempotencyKey}`,
				stageFingerprint: original.stageFingerprint,
				applyIdempotencyKey: idempotencyKey,
				rollbackOfRunId: runId,
				plan: original.plan,
				planSha256: original.planSha256,
				createdAt: now,
				updatedAt: now,
			})
			const pointers: Array<{ resourceId: string; versionId: string }> = []
			for (const receipt of receipts) {
				if (receipt.action === 'retain') continue
				const current = await trx.query.contentResource.findFirst({
					where: eq(contentResource.id, receipt.resourceId),
				})
				if (!current)
					throw new CourseSyncError(
						'ROLLBACK_RESOURCE_MISSING',
						'A rollback resource disappeared.',
						409,
					)
				const parent = receipt.parentVersionId
					? await trx.query.contentResourceVersion.findFirst({
							where: eq(contentResourceVersion.id, receipt.parentVersionId),
						})
					: null
				const currentFields = current.fields as Record<string, unknown>
				const fields = parent?.fields ?? {
					...currentFields,
					state: 'draft',
					visibility: 'unlisted',
					courseSync: {
						...((currentFields.courseSync as
							| Record<string, unknown>
							| undefined) ?? {}),
						active: false,
						rollbackOfRunId: runId,
					},
				}
				const latest = await trx.query.contentResourceVersion.findFirst({
					where: eq(contentResourceVersion.resourceId, receipt.resourceId),
					orderBy: desc(contentResourceVersion.versionNumber),
				})
				const versionId = `version~${sha256(stableJson({ compensatingRunId, resourceId: receipt.resourceId, fields }))}`
				await trx.insert(contentResourceVersion).values({
					id: versionId,
					resourceId: receipt.resourceId,
					parentVersionId: current.currentVersionId,
					versionNumber: (latest?.versionNumber ?? 0) + 1,
					fields,
					createdById,
				})
				await trx.insert(courseSyncRunResourceVersion).values({
					runId: compensatingRunId,
					resourceId: receipt.resourceId,
					contentResourceVersionId: versionId,
					parentVersionId: current.currentVersionId,
					action: 'update',
				})
				if (
					receipt.previousParentResourceId !== null &&
					receipt.previousPosition !== null
				) {
					await trx
						.update(contentResourceResource)
						.set({
							resourceOfId: receipt.previousParentResourceId,
							position: receipt.previousPosition,
						})
						.where(
							and(
								eq(contentResourceResource.resourceId, receipt.resourceId),
								isNull(contentResourceResource.deletedAt),
							),
						)
				}
				pointers.push({ resourceId: receipt.resourceId, versionId })
			}
			for (const pointer of pointers) {
				await trx
					.update(contentResource)
					.set({ currentVersionId: pointer.versionId, updatedAt: now })
					.where(eq(contentResource.id, pointer.resourceId))
			}
			await trx
				.update(courseSyncRun)
				.set({ state: 'applied', updatedAt: now })
				.where(eq(courseSyncRun.runId, compensatingRunId))
			await trx
				.update(courseSyncRun)
				.set({ state: 'rolled_back', compensatingRunId, updatedAt: now })
				.where(eq(courseSyncRun.runId, runId))
		})
		const rolledBack = await readRun(runId)
		if (!rolledBack)
			throw new CourseSyncError(
				'RUN_NOT_FOUND',
				'Rolled-back run disappeared.',
				500,
			)
		return rolledBack
	},
}
