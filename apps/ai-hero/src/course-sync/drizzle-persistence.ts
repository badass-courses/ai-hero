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
import { log } from '@/server/logger'
import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm'

import { resolveStoredCourseSyncBinding } from './binding-migration'
import { CourseSyncError } from './errors'
import { sha256, stableJson } from './control-plane'
import { chunkCourseSyncWrites } from './persistence-invariants'
import { assertCourseSyncTargetContract } from './target-contract'
import { AI_HERO_COURSE_SYNC_BINDING } from './types'
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

function resourceType(sourceKind: SyncPlan['resources'][number]['sourceKind']) {
	return sourceKind === 'video' ? 'videoResource' : sourceKind
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
			const resolved = resolveStoredCourseSyncBinding(existing.binding, binding)
			if (!resolved.migrated) return resolved.binding

			let migrated = false
			const locked = await db.transaction(async (trx) => {
				const [current] = await trx
					.select()
					.from(courseSyncBinding)
					.where(eq(courseSyncBinding.bindingId, binding.bindingId))
					.for('update')
				if (!current) {
					throw new CourseSyncError(
						'IMMUTABLE_BINDING_CONFLICT',
						'The stored sync binding disappeared during migration.',
						409,
						{ category: 'lifecycle_conflict', retryable: false },
					)
				}
				const currentResolved = resolveStoredCourseSyncBinding(
					current.binding,
					binding,
				)
				if (currentResolved.migrated) {
					await trx
						.update(courseSyncBinding)
						.set({
							sourceCourseId: binding.sourceCourseId,
							productId: binding.productId,
							anchorWorkshopId: binding.anchorWorkshopId,
							status: binding.status,
							binding,
						})
						.where(eq(courseSyncBinding.bindingId, binding.bindingId))
					migrated = true
				}
				return currentResolved.binding
			})
			if (migrated) {
				await log.info('course_sync.binding.migrated', {
					bindingId: binding.bindingId,
					fromContractVersion: 1,
					toContractVersion: 2,
				})
			}
			return locked
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
		assertCourseSyncTargetContract(binding, {
			product: product
				? {
						id: product.id,
						type: product.type ?? 'missing',
						fields: product.fields,
					}
				: null,
			workshop: workshop
				? {
						id: workshop.id,
						type: workshop.type,
						fields: workshop.fields,
						deletedAt: workshop.deletedAt,
					}
				: null,
			relation: relation ? { position: relation.position } : null,
			otherProductRelations,
			childRelations: childRelations.map((child) => ({
				position: child.position,
				resource: child.resource
					? {
							id: child.resource.id,
							type: child.resource.type,
							fields: child.resource.fields,
						}
					: null,
			})),
		})
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
		// Sorting full rows drags the multi-hundred-KB `plan` JSON through
		// MySQL's 256KB sort buffer (errno 1038); sort a slim projection and
		// fetch the winner by primary key instead.
		const pointer = await db.query.courseSyncRun.findFirst({
			columns: { runId: true },
			where: and(
				eq(courseSyncRun.bindingId, bindingId),
				eq(courseSyncRun.courseVersionId, courseVersionId),
				eq(courseSyncRun.state, 'applied'),
				isNull(courseSyncRun.rollbackOfRunId),
			),
			orderBy: desc(courseSyncRun.updatedAt),
		})
		return pointer ? readRun(pointer.runId) : null
	},

	async findFrozenAsset(bindingId, producerSha256, bytes) {
		const [asset] = await db
			.select({
				sourceVideoId: courseSyncSourceRevisionAsset.sourceVideoId,
				relativePath: courseSyncSourceRevisionAsset.relativePath,
				providerRevision: courseSyncSourceRevisionAsset.providerRevision,
				producerSha256: courseSyncSourceRevisionAsset.producerSha256,
				bytes: courseSyncSourceRevisionAsset.bytes,
				snapshotUri: courseSyncSourceRevisionAsset.snapshotUri,
				muxAssetId: courseSyncSourceRevisionAsset.muxAssetId,
				muxPlaybackId: courseSyncSourceRevisionAsset.muxPlaybackId,
				providerContentHash: courseSyncSourceRevisionAsset.providerContentHash,
				duration: courseSyncSourceRevisionAsset.duration,
			})
			.from(courseSyncSourceRevisionAsset)
			.innerJoin(
				courseSyncSourceRevision,
				eq(
					courseSyncSourceRevision.sourceRevisionId,
					courseSyncSourceRevisionAsset.sourceRevisionId,
				),
			)
			.where(
				and(
					eq(courseSyncSourceRevision.bindingId, bindingId),
					eq(courseSyncSourceRevisionAsset.producerSha256, producerSha256),
					eq(courseSyncSourceRevisionAsset.bytes, bytes),
				),
			)
			.orderBy(desc(courseSyncSourceRevision.stagedAt))
			.limit(1)
		return asset ?? null
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
		// Same sort-buffer hazard as findAppliedRunByRevision: never ORDER BY
		// over rows that carry the `plan` JSON.
		const pointer = await db.query.courseSyncRun.findFirst({
			columns: { runId: true },
			where: and(
				eq(courseSyncRun.bindingId, bindingId),
				eq(courseSyncRun.state, 'applied'),
				isNull(courseSyncRun.rollbackOfRunId),
			),
			orderBy: desc(courseSyncRun.updatedAt),
		})
		return pointer ? readRun(pointer.runId) : null
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

			const [storedBinding] = await trx
				.select({ binding: courseSyncBinding.binding })
				.from(courseSyncBinding)
				.where(eq(courseSyncBinding.bindingId, plan.bindingId))
				.for('update')
			if (!storedBinding) {
				throw new CourseSyncError(
					'BINDING_NOT_FOUND',
					'Sync binding not found during apply.',
					409,
					{ category: 'target_precondition', retryable: false },
				)
			}
			const binding = resolveStoredCourseSyncBinding(
				storedBinding.binding,
				AI_HERO_COURSE_SYNC_BINDING,
			).binding
			const [lockedProduct] = await trx
				.select()
				.from(products)
				.where(eq(products.id, binding.productId))
				.for('update')
			const [lockedWorkshop] = await trx
				.select()
				.from(contentResource)
				.where(eq(contentResource.id, binding.anchorWorkshopId))
				.for('update')
			const lockedProductRelations = await trx
				.select()
				.from(contentResourceProduct)
				.where(
					and(
						eq(contentResourceProduct.resourceId, binding.anchorWorkshopId),
						isNull(contentResourceProduct.deletedAt),
					),
				)
				.for('update')
			const lockedChildren = await trx
				.select({
					position: contentResourceResource.position,
					resourceId: contentResource.id,
					resourceType: contentResource.type,
					resourceFields: contentResource.fields,
				})
				.from(contentResourceResource)
				.leftJoin(
					contentResource,
					eq(contentResource.id, contentResourceResource.resourceId),
				)
				.where(
					and(
						eq(contentResourceResource.resourceOfId, binding.anchorWorkshopId),
						isNull(contentResourceResource.deletedAt),
					),
				)
				.for('update')
			const lockedRelation = lockedProductRelations.find(
				(relation) => relation.productId === binding.productId,
			)
			assertCourseSyncTargetContract(binding, {
				product: lockedProduct
					? {
							id: lockedProduct.id,
							type: lockedProduct.type ?? 'missing',
							fields: lockedProduct.fields,
						}
					: null,
				workshop: lockedWorkshop
					? {
							id: lockedWorkshop.id,
							type: lockedWorkshop.type,
							fields: lockedWorkshop.fields,
							deletedAt: lockedWorkshop.deletedAt,
						}
					: null,
				relation: lockedRelation ? { position: lockedRelation.position } : null,
				otherProductRelations: lockedProductRelations.filter(
					(relation) => relation.productId !== binding.productId,
				),
				childRelations: lockedChildren.map((child) => ({
					position: child.position,
					resource: child.resourceId
						? {
								id: child.resourceId,
								type: child.resourceType ?? 'missing',
								fields: child.resourceFields,
							}
						: null,
				})),
			})

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
						type: resourceType(item.sourceKind),
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
						existing.type !== resourceType(item.sourceKind) ||
						fields.state !== (item.sourceKind === 'video' ? 'ready' : 'draft') ||
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
					const relations =
						relationsByResource.get(item.targetResourceId) ?? []
					const activeRelations = relations.filter(
						(relation) => relation.deletedAt === null,
					)
					const expectedRelations = item.previousDetached
						? relations.filter(
								(relation) =>
									relation.deletedAt !== null &&
									// The tombstone was written under the OLD parent. Filtering
									// by the new planned parent finds nothing when a restore
									// also moves the resource, aborting the apply.
									relation.resourceOfId ===
										(item.previousParentResourceId ?? item.parentResourceId),
							)
						: activeRelations.filter(
								(relation) => relation.resourceOfId === item.parentResourceId,
							)
					if (
						expectedRelations.length !== 1 ||
						(item.previousDetached
							? activeRelations.length !== 0
							: activeRelations.length !== 1)
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
						type: resourceType(item.sourceKind),
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
					deletedAt: item.detached ? new Date() : null,
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
							deletedAt: sql`values(${contentResourceResource.deletedAt})`,
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
				const planItem = original.plan?.resources.find(
					(item) => item.targetResourceId === receipt.resourceId,
				)
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
					state: planItem?.sourceKind === 'video' ? 'deleted' : 'draft',
					visibility: 'unlisted',
					courseSync: {
						...((currentFields.courseSync as
							| Record<string, unknown>
							| undefined) ?? {}),
						active: false,
						rollbackOfRunId: runId,
					},
				}
				// Version rows carry large `fields` JSON; aggregate instead of
				// sorting them through the MySQL sort buffer.
				const [latest] = await trx
					.select({ versionNumber: max(contentResourceVersion.versionNumber) })
					.from(contentResourceVersion)
					.where(eq(contentResourceVersion.resourceId, receipt.resourceId))
				const versionId = `version~${sha256(stableJson({ compensatingRunId, resourceId: receipt.resourceId, fields }))}`
				await trx.insert(contentResourceVersion).values({
					id: versionId,
					resourceId: receipt.resourceId,
					parentVersionId: current.currentVersionId,
					versionNumber: Number(latest?.versionNumber ?? 0) + 1,
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
							deletedAt: planItem?.previousDetached ? now : null,
						})
						.where(
							and(
								eq(contentResourceResource.resourceId, receipt.resourceId),
								eq(
									contentResourceResource.resourceOfId,
									receipt.previousParentResourceId,
								),
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
