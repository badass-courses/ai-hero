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
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm'

import { CourseSyncError } from './errors'
import { sha256, stableJson } from './control-plane'
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
		const childPositions = childRelations.map((child) => child.position)
		if (
			childRelations.length > 2 ||
			new Set(childPositions).size !== childPositions.length
		) {
			throw new CourseSyncError(
				'TARGET_CHILD_SCOPE_WIDENED',
				'The bound workshop does not have one unique slot per managed section.',
				409,
			)
		}
		for (const child of childRelations) {
			const fields = child.resource?.fields as
				| Record<string, unknown>
				| undefined
			const sync = fields?.courseSync as Record<string, unknown> | undefined
			if (
				child.resource?.type !== 'section' ||
				fields?.state !== binding.requiredState ||
				fields.visibility !== binding.requiredVisibility ||
				sync?.bindingId !== binding.bindingId ||
				child.position < 0 ||
				child.position > 1
			) {
				throw new CourseSyncError(
					'TARGET_CHILD_SCOPE_WIDENED',
					'The bound workshop contains a relation outside the two managed sections.',
					409,
				)
			}
		}
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
				row.state !== 'previewed' ||
				row.planSha256 !== plan.planSha256
			) {
				throw new CourseSyncError(
					'APPLY_CONCURRENCY_CONFLICT',
					'The previewed run changed before apply.',
					409,
				)
			}
			await trx
				.update(courseSyncRun)
				.set({ state: 'applying', applyIdempotencyKey: idempotencyKey })
				.where(eq(courseSyncRun.runId, runId))

			const pointerUpdates: Array<{ resourceId: string; versionId: string }> =
				[]
			for (const item of plan.resources) {
				const existing = await trx.query.contentResource.findFirst({
					where: eq(contentResource.id, item.targetResourceId),
				})
				if (item.action === 'create') {
					if (existing)
						throw new CourseSyncError(
							'RESOURCE_ALREADY_EXISTS',
							'A planned resource ID already exists.',
							409,
						)
					await trx.insert(contentResource).values({
						id: item.targetResourceId,
						type: item.sourceKind,
						createdById,
						fields: item.fields,
					})
					await trx.insert(contentResourceResource).values({
						resourceOfId: item.parentResourceId,
						resourceId: item.targetResourceId,
						position: item.position,
						metadata: { bindingId: plan.bindingId, sourceId: item.sourceId },
					})
				} else if (!existing) {
					throw new CourseSyncError(
						'MANAGED_RESOURCE_MISSING',
						'A managed target resource disappeared.',
						409,
					)
				} else {
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
					const relation = await trx.query.contentResourceResource.findFirst({
						where: and(
							eq(contentResourceResource.resourceOfId, item.parentResourceId),
							eq(contentResourceResource.resourceId, item.targetResourceId),
							isNull(contentResourceResource.deletedAt),
						),
					})
					if (!relation)
						throw new CourseSyncError(
							'MANAGED_RELATION_MISSING',
							'A managed relation disappeared.',
							409,
						)
					if (relation.position !== item.position) {
						await trx
							.update(contentResourceResource)
							.set({ position: item.position })
							.where(
								and(
									eq(
										contentResourceResource.resourceOfId,
										item.parentResourceId,
									),
									eq(contentResourceResource.resourceId, item.targetResourceId),
								),
							)
					}
				}

				if (item.action === 'retain') {
					if (!existing?.currentVersionId) {
						throw new CourseSyncError(
							'RETAINED_VERSION_MISSING',
							'A retained resource has no current version.',
							409,
						)
					}
					await trx.insert(courseSyncRunResourceVersion).values({
						runId,
						resourceId: item.targetResourceId,
						contentResourceVersionId: existing.currentVersionId,
						parentVersionId: existing.currentVersionId,
						previousParentResourceId: item.previousParentResourceId,
						previousPosition: item.previousPosition,
						action: item.action,
					})
					continue
				}
				const latest = await trx.query.contentResourceVersion.findFirst({
					where: eq(contentResourceVersion.resourceId, item.targetResourceId),
					orderBy: desc(contentResourceVersion.versionNumber),
				})
				const versionId = `version~${sha256(stableJson({ runId, resourceId: item.targetResourceId, fields: item.fields }))}`
				await trx.insert(contentResourceVersion).values({
					id: versionId,
					resourceId: item.targetResourceId,
					parentVersionId: existing?.currentVersionId ?? null,
					versionNumber: (latest?.versionNumber ?? 0) + 1,
					fields: item.fields,
					createdById,
				})
				await trx.insert(courseSyncRunResourceVersion).values({
					runId,
					resourceId: item.targetResourceId,
					contentResourceVersionId: versionId,
					parentVersionId: existing?.currentVersionId ?? null,
					previousParentResourceId: item.previousParentResourceId,
					previousPosition: item.previousPosition,
					action: item.action,
				})
				pointerUpdates.push({ resourceId: item.targetResourceId, versionId })
			}

			for (const pointer of pointerUpdates) {
				await trx
					.update(contentResource)
					.set({ currentVersionId: pointer.versionId, updatedAt: new Date() })
					.where(eq(contentResource.id, pointer.resourceId))
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

	async markFailed(runId, code, reason) {
		await db
			.update(courseSyncRun)
			.set({
				state: 'failed',
				failureCode: code,
				failureReason: reason,
				updatedAt: new Date(),
			})
			.where(eq(courseSyncRun.runId, runId))
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
