import { db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	contentResourceResource,
	contentResourceVersion,
	courseSyncBinding,
	courseSyncFrozenAssetReceipt,
	courseSyncPollLog,
	courseSyncPollState,
	courseSyncRun,
	courseSyncRunResourceVersion,
	courseSyncSourceRevision,
	courseSyncSourceRevisionAsset,
	products,
} from '@/db/schema'
import { log } from '@/server/logger'
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import { resolveStoredCourseSyncBinding } from './binding-migration'
import { CourseSyncError } from './errors'
import {
	courseSyncRollbackStageIdempotencyKey,
	sha256,
	stableJson,
} from './control-plane'
import {
	assertCourseSyncLaunchApplyPolicy,
	chunkCourseSyncWrites,
	courseSyncRollbackPointer,
	resolveCourseSyncRollbackFields,
} from './persistence-invariants'
import { assertAdoptableSolutionResource } from './solution-adoption'
import { assertCourseSyncTargetContract } from './target-contract'
import { AI_HERO_COURSE_SYNC_BINDING } from './types'
import type {
	CourseSyncBinding,
	CourseSyncPersistence,
	FrozenSourceAsset,
	SolutionResourceAdoption,
	SolutionResourceAdoptionCandidate,
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

			let migratedFromContractVersion: 2 | 3 | null = null
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
					const occurredAt = new Date()
					const fromContractVersion = currentResolved.fromContractVersion
					if (fromContractVersion === null) {
						throw new CourseSyncError(
							'IMMUTABLE_BINDING_CONFLICT',
							'Migrated binding is missing its prior contract version.',
							409,
							{ category: 'lifecycle_conflict', retryable: false },
						)
					}
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
					await trx
						.insert(courseSyncPollLog)
						.values({
							id: `cspl_binding_migration_${sha256(`${binding.bindingId}:v${binding.contractVersion}`)}`,
							bindingId: binding.bindingId,
							courseVersionId: 'unknown',
							providerRevision: 'unknown',
							runId: `binding-migration:${binding.bindingId}:v${fromContractVersion}-v${binding.contractVersion}`,
							stage: 'migration',
							outcome: 'succeeded',
							metadata: {
								fromContractVersion,
								toContractVersion: binding.contractVersion,
							},
							occurredAt,
						})
						.onDuplicateKeyUpdate({
							set: { id: sql`values(${courseSyncPollLog.id})` },
						})
					migratedFromContractVersion = fromContractVersion
				}
				return currentResolved.binding
			})
			if (migratedFromContractVersion !== null) {
				void log
					.info('course_sync.binding.migrated', {
						bindingId: binding.bindingId,
						fromContractVersion: migratedFromContractVersion,
						toContractVersion: binding.contractVersion,
					})
					.catch(() => undefined)
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

	async findFrozenAssetReceipt(receiptKey) {
		const row = await db.query.courseSyncFrozenAssetReceipt.findFirst({
			where: eq(courseSyncFrozenAssetReceipt.receiptKey, receiptKey),
		})
		return row
			? {
					sourceVideoId: row.sourceVideoId,
					relativePath: row.relativePath,
					providerRevision: row.providerRevision,
					providerContentHash: row.providerContentHash,
					producerSha256: row.producerSha256,
					bytes: row.bytes,
					snapshotUri: row.snapshotUri,
					muxAssetId: row.muxAssetId,
					muxPlaybackId: row.muxPlaybackId,
					duration: row.duration,
				}
			: null
	},

	async saveFrozenAssetReceipt({
		receiptKey,
		bindingId,
		courseVersionId,
		asset,
	}) {
		if (!asset.muxAssetId) {
			throw new CourseSyncError(
				'FROZEN_ASSET_RECEIPT_INCOMPLETE',
				'A frozen asset receipt requires a Mux asset ID.',
				500,
				{ category: 'internal', retryable: false },
			)
		}
		await db
			.insert(courseSyncFrozenAssetReceipt)
			.values({
				receiptKey,
				bindingId,
				courseVersionId,
				sourceVideoId: asset.sourceVideoId,
				relativePath: asset.relativePath,
				providerRevision: asset.providerRevision,
				providerContentHash: asset.providerContentHash,
				producerSha256: asset.producerSha256,
				bytes: asset.bytes,
				snapshotUri: asset.snapshotUri,
				muxAssetId: asset.muxAssetId,
				muxPlaybackId: asset.muxPlaybackId,
				duration: asset.duration,
			})
			.onDuplicateKeyUpdate({
				set: {
					muxPlaybackId: sql`if(${courseSyncFrozenAssetReceipt.muxAssetId} = values(${courseSyncFrozenAssetReceipt.muxAssetId}), values(${courseSyncFrozenAssetReceipt.muxPlaybackId}), ${courseSyncFrozenAssetReceipt.muxPlaybackId})`,
					duration: sql`if(${courseSyncFrozenAssetReceipt.muxAssetId} = values(${courseSyncFrozenAssetReceipt.muxAssetId}), values(${courseSyncFrozenAssetReceipt.duration}), ${courseSyncFrozenAssetReceipt.duration})`,
					updatedAt: sql`if(${courseSyncFrozenAssetReceipt.muxAssetId} = values(${courseSyncFrozenAssetReceipt.muxAssetId}), values(${courseSyncFrozenAssetReceipt.updatedAt}), ${courseSyncFrozenAssetReceipt.updatedAt})`,
				},
			})
		const stored = await this.findFrozenAssetReceipt(receiptKey)
		if (!stored) {
			throw new CourseSyncError(
				'FROZEN_ASSET_RECEIPT_MISSING',
				'The frozen asset receipt disappeared after persistence.',
				500,
			)
		}
		return stored
	},

	async createStaged({ revision, run }) {
		await db.transaction(async (trx) => {
			await trx
				.select({ bindingId: courseSyncBinding.bindingId })
				.from(courseSyncBinding)
				.where(eq(courseSyncBinding.bindingId, revision.bindingId))
				.for('update')
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
					sourceVideoId: asset.sourceVideoId,
					relativePath: asset.relativePath,
					providerRevision: asset.providerRevision,
					providerContentHash: asset.providerContentHash,
					producerSha256: asset.producerSha256,
					bytes: asset.bytes,
					snapshotUri: asset.snapshotUri,
					muxAssetId: asset.muxAssetId,
					muxPlaybackId: asset.muxPlaybackId,
					duration: asset.duration,
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

	async findSolutionResourceAdoptions(
		bindingId: string,
		candidates: ReadonlyArray<SolutionResourceAdoptionCandidate>,
	) {
		if (candidates.length === 0) {
			return new Map<string, SolutionResourceAdoption>()
		}
		const canonicalIds = candidates.map(
			(candidate) => candidate.canonicalTargetResourceId,
		)
		const lessonIds = candidates.map((candidate) => candidate.lessonResourceId)
		const [canonicalRows, solutionRows] = await Promise.all([
			db
				.select({ id: contentResource.id })
				.from(contentResource)
				.where(inArray(contentResource.id, canonicalIds)),
			db
				.select({
					lessonResourceId: contentResourceResource.resourceOfId,
					position: contentResourceResource.position,
					resourceId: contentResource.id,
					type: contentResource.type,
					currentVersionId: contentResource.currentVersionId,
					fields: contentResource.fields,
				})
				.from(contentResourceResource)
				.innerJoin(
					contentResource,
					eq(contentResource.id, contentResourceResource.resourceId),
				)
				.where(
					and(
						inArray(contentResourceResource.resourceOfId, lessonIds),
						isNull(contentResourceResource.deletedAt),
						eq(contentResource.type, 'solution'),
					),
				),
		])
		const canonicalExisting = new Set(canonicalRows.map((row) => row.id))
		const manualSolutionIds = solutionRows
			.map((row) => row.resourceId)
			.filter((resourceId) => !canonicalExisting.has(resourceId))
		const childRows =
			manualSolutionIds.length === 0
				? []
				: await db
						.select({
							parentResourceId: contentResourceResource.resourceOfId,
							resourceId: contentResourceResource.resourceId,
							position: contentResourceResource.position,
							type: contentResource.type,
						})
						.from(contentResourceResource)
						.innerJoin(
							contentResource,
							eq(contentResource.id, contentResourceResource.resourceId),
						)
						.where(
							and(
								inArray(
									contentResourceResource.resourceOfId,
									manualSolutionIds,
								),
								isNull(contentResourceResource.deletedAt),
							),
						)
		const adoptions = new Map<string, SolutionResourceAdoption>()
		for (const candidate of candidates) {
			const matchingRows = solutionRows.filter(
				(row) => row.lessonResourceId === candidate.lessonResourceId,
			)
			if (canonicalExisting.has(candidate.canonicalTargetResourceId)) {
				if (
					matchingRows.some(
						(row) => row.resourceId !== candidate.canonicalTargetResourceId,
					)
				) {
					throw new CourseSyncError(
						'SOLUTION_ADOPTION_RELATION_CONFLICT',
						`Lesson ${candidate.sourceLessonId} has both canonical and manual solution resources.`,
						409,
						{ category: 'target_precondition', retryable: false },
					)
				}
				continue
			}
			if (matchingRows.length === 0) continue
			if (matchingRows.length !== 1) {
				throw new CourseSyncError(
					'SOLUTION_ADOPTION_RELATION_CONFLICT',
					`Lesson ${candidate.sourceLessonId} has more than one active solution child.`,
					409,
					{ category: 'target_precondition', retryable: false },
				)
			}
			const resource = matchingRows[0]!
			const fields = (resource.fields ?? {}) as Record<string, unknown>
			assertAdoptableSolutionResource({
				bindingId,
				candidate,
				resource: {
					id: resource.resourceId,
					type: resource.type,
					fields,
				},
			})
			const children = childRows.filter(
				(row) => row.parentResourceId === resource.resourceId,
			)
			if (
				children.length !== 1 ||
				children[0]?.resourceId !== candidate.solutionVideoResourceId ||
				children[0]?.position !== 0 ||
				children[0]?.type !== 'videoResource'
			) {
				throw new CourseSyncError(
					'SOLUTION_ADOPTION_RELATION_CONFLICT',
					`Solution ${resource.resourceId} does not own exactly the expected repaired video.`,
					409,
					{ category: 'target_precondition', retryable: false },
				)
			}
			adoptions.set(candidate.canonicalTargetResourceId, {
				canonicalTargetResourceId: candidate.canonicalTargetResourceId,
				resourceId: resource.resourceId,
				lessonResourceId: candidate.lessonResourceId,
				solutionVideoResourceId: candidate.solutionVideoResourceId,
				currentVersionId: resource.currentVersionId,
				fields,
				position: resource.position,
			})
		}
		return adoptions
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
		assertCourseSyncLaunchApplyPolicy(plan)
		await db.transaction(async (trx) => {
			// The binding row is the serialization lock for apply, preview-head
			// changes, and rollback. Acquire it before every other mutable row.
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
			const [row] = await trx
				.select()
				.from(courseSyncRun)
				.where(eq(courseSyncRun.runId, runId))
				.for('update')
			const { planSha256: claimedPlanSha256, ...planInput } = plan
			if (
				!row ||
				(row.state !== 'previewed' && row.state !== 'failed') ||
				row.planSha256 !== plan.planSha256 ||
				claimedPlanSha256 !== sha256(stableJson(planInput)) ||
				stableJson(row.plan) !== stableJson(plan)
			) {
				throw new CourseSyncError(
					'APPLY_CONCURRENCY_CONFLICT',
					'The locked run or content-addressed plan changed before apply.',
					409,
					{ category: 'lifecycle_conflict', retryable: false },
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
					{ category: 'lifecycle_conflict', retryable: false },
				)
			}
			const [lockedRevision] = await trx
				.select()
				.from(courseSyncSourceRevision)
				.where(
					eq(courseSyncSourceRevision.sourceRevisionId, row.sourceRevisionId),
				)
				.for('update')
			const competingRuns = await trx
				.select({ runId: courseSyncRun.runId })
				.from(courseSyncRun)
				.where(
					and(
						eq(courseSyncRun.bindingId, binding.bindingId),
						inArray(courseSyncRun.state, ['staged', 'previewed', 'applying']),
					),
				)
				.for('update')
			const [lockedPollState] = await trx
				.select()
				.from(courseSyncPollState)
				.where(eq(courseSyncPollState.bindingId, binding.bindingId))
				.for('update')
			const pollStateAuthorizesApply =
				lockedPollState !== undefined &&
				lockedPollState.controlPlaneRunId === runId &&
				lockedPollState.courseVersionId === plan.courseVersionId &&
				lockedPollState.providerRevision === lockedRevision?.providerRevision &&
				(lockedPollState.status === 'awaiting-apply' ||
					(binding.applyPolicy === 'bounded-auto' &&
						lockedPollState.status === 'applying'))
			if (
				!lockedRevision ||
				competingRuns.some((candidate) => candidate.runId !== runId) ||
				row.bindingId !== binding.bindingId ||
				row.sourceRevisionId !== plan.sourceRevisionId ||
				row.courseVersionId !== plan.courseVersionId ||
				lockedRevision.courseVersionId !== plan.courseVersionId ||
				lockedRevision.bindingId !== binding.bindingId ||
				!pollStateAuthorizesApply
			) {
				throw new CourseSyncError(
					'STALE_PREVIEW',
					'The run is not the current authorized apply head.',
					409,
					{ category: 'lifecycle_conflict', retryable: false },
				)
			}
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
				.for('update')
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
				.for('update')
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
				.for('update')
			const relationsByResource = new Map<
				string,
				Array<(typeof relationRows)[number]>
			>()
			for (const relation of relationRows) {
				const relations = relationsByResource.get(relation.resourceId) ?? []
				relations.push(relation)
				relationsByResource.set(relation.resourceId, relations)
			}
			const solutionAdoptionItems = plan.resources.filter(
				(item) => item.solutionAdoption !== undefined,
			)
			const adoptionLessonIds = solutionAdoptionItems.map(
				(item) => item.previousParentResourceId ?? item.parentResourceId,
			)
			const adoptionSolutionIds = solutionAdoptionItems.map(
				(item) => item.targetResourceId,
			)
			const adoptionLessonRelations =
				adoptionLessonIds.length === 0
					? []
					: await trx
							.select({
								parentResourceId: contentResourceResource.resourceOfId,
								resourceId: contentResourceResource.resourceId,
								position: contentResourceResource.position,
								type: contentResource.type,
							})
							.from(contentResourceResource)
							.innerJoin(
								contentResource,
								eq(contentResource.id, contentResourceResource.resourceId),
							)
							.where(
								and(
									inArray(
										contentResourceResource.resourceOfId,
										adoptionLessonIds,
									),
									isNull(contentResourceResource.deletedAt),
									eq(contentResource.type, 'solution'),
								),
							)
							.for('update')
			const adoptionChildRelations =
				adoptionSolutionIds.length === 0
					? []
					: await trx
							.select({
								parentResourceId: contentResourceResource.resourceOfId,
								resourceId: contentResourceResource.resourceId,
								position: contentResourceResource.position,
								type: contentResource.type,
							})
							.from(contentResourceResource)
							.innerJoin(
								contentResource,
								eq(contentResource.id, contentResourceResource.resourceId),
							)
							.where(
								and(
									inArray(
										contentResourceResource.resourceOfId,
										adoptionSolutionIds,
									),
									isNull(contentResourceResource.deletedAt),
								),
							)
							.for('update')
			const lockedVersions = await trx
				.select({
					resourceId: contentResourceVersion.resourceId,
					versionNumber: contentResourceVersion.versionNumber,
				})
				.from(contentResourceVersion)
				.where(inArray(contentResourceVersion.resourceId, resourceIds))
				.for('update')
			const latestVersionByResource = new Map<string, number>()
			for (const version of lockedVersions) {
				latestVersionByResource.set(
					version.resourceId,
					Math.max(
						latestVersionByResource.get(version.resourceId) ?? 0,
						version.versionNumber,
					),
				)
			}

			const newResources: Array<typeof contentResource.$inferInsert> = []
			const versions: Array<typeof contentResourceVersion.$inferInsert> = []
			const receipts: Array<typeof courseSyncRunResourceVersion.$inferInsert> =
				[]
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
					if (
						(relationsByResource.get(item.targetResourceId) ?? []).length > 0
					) {
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
					if (item.solutionAdoption) {
						const solutionVideoResourceId = item.fields.videoResourceId
						if (
							item.sourceKind !== 'solution' ||
							typeof solutionVideoResourceId !== 'string'
						) {
							throw new CourseSyncError(
								'SOLUTION_ADOPTION_SCOPE_MISMATCH',
								'The solution adoption plan is malformed.',
								409,
								{ category: 'target_precondition', retryable: false },
							)
						}
						const lessonResourceId =
							item.previousParentResourceId ?? item.parentResourceId
						assertAdoptableSolutionResource({
							bindingId: plan.bindingId,
							candidate: {
								canonicalTargetResourceId:
									item.solutionAdoption.canonicalTargetResourceId,
								lessonResourceId,
								solutionVideoResourceId,
								sourceLessonId: item.sourceId,
							},
							resource: { id: existing.id, type: existing.type, fields },
						})
						const solutionSiblings = adoptionLessonRelations.filter(
							(relation) => relation.parentResourceId === lessonResourceId,
						)
						const solutionChildren = adoptionChildRelations.filter(
							(relation) => relation.parentResourceId === existing.id,
						)
						if (
							solutionSiblings.length !== 1 ||
							solutionSiblings[0]?.resourceId !== existing.id ||
							solutionSiblings[0]?.position !== item.previousPosition ||
							solutionChildren.length !== 1 ||
							solutionChildren[0]?.resourceId !== solutionVideoResourceId ||
							solutionChildren[0]?.position !== 0 ||
							solutionChildren[0]?.type !== 'videoResource'
						) {
							throw new CourseSyncError(
								'SOLUTION_ADOPTION_RELATION_CONFLICT',
								'The repaired solution topology changed after preview.',
								409,
								{ category: 'lifecycle_conflict', retryable: false },
							)
						}
					} else if (
						existing.type !== resourceType(item.sourceKind) ||
						fields.state !==
							(item.sourceKind === 'video' ? 'ready' : 'draft') ||
						fields.visibility !== 'unlisted' ||
						sync?.bindingId !== plan.bindingId
					) {
						throw new CourseSyncError(
							'MANAGED_RESOURCE_SCOPE_MISMATCH',
							'A managed resource left draft sync scope.',
							409,
						)
					}
					const expectedCurrentVersionId =
						item.solutionAdoption?.createBaselineVersion === true
							? null
							: item.previousVersionId
					if (
						existing.currentVersionId !== expectedCurrentVersionId ||
						sha256(stableJson(existing.fields ?? {})) !==
							item.previousFieldsSha256
					) {
						throw new CourseSyncError(
							'APPLY_TARGET_CHANGED',
							'A managed resource pointer or fields changed after preview.',
							409,
							{ category: 'lifecycle_conflict', retryable: false },
						)
					}
					const relations = relationsByResource.get(item.targetResourceId) ?? []
					const activeRelations = relations.filter(
						(relation) => relation.deletedAt === null,
					)
					const previousParentResourceId =
						item.previousParentResourceId ?? item.parentResourceId
					const previousPosition = item.previousPosition ?? item.position
					const expectedRelations = item.previousDetached
						? relations.filter(
								(relation) =>
									relation.deletedAt !== null &&
									relation.resourceOfId === previousParentResourceId &&
									relation.position === previousPosition,
							)
						: activeRelations.filter(
								(relation) =>
									relation.resourceOfId === previousParentResourceId &&
									relation.position === previousPosition,
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

				let parentVersionId = existing?.currentVersionId ?? null
				let nextVersionNumber =
					(latestVersionByResource.get(item.targetResourceId) ?? 0) + 1
				if (item.solutionAdoption?.createBaselineVersion) {
					if (
						parentVersionId !== null ||
						latestVersionByResource.has(item.targetResourceId)
					) {
						throw new CourseSyncError(
							'SOLUTION_ADOPTION_BASELINE_CONFLICT',
							'The repaired solution gained a version pointer after preview.',
							409,
							{ category: 'lifecycle_conflict', retryable: false },
						)
					}
					versions.push({
						id: item.solutionAdoption.baselineVersionId,
						resourceId: item.targetResourceId,
						parentVersionId: null,
						versionNumber: nextVersionNumber,
						fields: existing?.fields ?? {},
						createdById,
					})
					parentVersionId = item.solutionAdoption.baselineVersionId
					nextVersionNumber += 1
				}
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
						versionNumber: nextVersionNumber,
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

			const activatedResources = await trx
				.select({
					id: contentResource.id,
					currentVersionId: contentResource.currentVersionId,
					fields: contentResource.fields,
				})
				.from(contentResource)
				.where(inArray(contentResource.id, resourceIds))
			const activatedRelations = await trx
				.select({
					resourceOfId: contentResourceResource.resourceOfId,
					resourceId: contentResourceResource.resourceId,
					position: contentResourceResource.position,
				})
				.from(contentResourceResource)
				.where(
					and(
						inArray(contentResourceResource.resourceId, resourceIds),
						isNull(contentResourceResource.deletedAt),
					),
				)
			const expectedPlanByResource = new Map(
				plan.resources.map((item) => [item.targetResourceId, item]),
			)
			const expectedReceiptByResource = new Map(
				receipts.map((receipt) => [receipt.resourceId, receipt]),
			)
			const activeRelationsByResource = new Map<
				string,
				Array<(typeof activatedRelations)[number]>
			>()
			for (const relation of activatedRelations) {
				const active = activeRelationsByResource.get(relation.resourceId) ?? []
				active.push(relation)
				activeRelationsByResource.set(relation.resourceId, active)
			}
			const activationMismatch =
				activatedResources.length !== plan.resources.length ||
				activatedRelations.length !== plan.resources.length ||
				activatedResources.some((resource) => {
					const item = expectedPlanByResource.get(resource.id)
					const receipt = expectedReceiptByResource.get(resource.id)
					const relations = activeRelationsByResource.get(resource.id) ?? []
					return (
						!item ||
						!receipt ||
						resource.currentVersionId !== receipt.contentResourceVersionId ||
						stableJson(resource.fields ?? {}) !== stableJson(item.fields) ||
						relations.length !== 1 ||
						relations[0]?.resourceOfId !== item.parentResourceId ||
						relations[0]?.position !== item.position
					)
				})
			if (activationMismatch) {
				throw new CourseSyncError(
					'APPLY_WRITE_VERIFICATION_FAILED',
					'Applied pointers, fields, relations, or version receipts did not match the content-addressed plan.',
					500,
					{ category: 'internal', retryable: false },
				)
			}

			const appliedAt = new Date()
			await trx
				.update(courseSyncRun)
				.set({ state: 'applied', updatedAt: appliedAt })
				.where(eq(courseSyncRun.runId, runId))
			await trx
				.update(courseSyncPollState)
				.set({
					status: 'succeeded',
					consecutiveFailures: 0,
					failureClass: null,
					applyPolicyOverride: null,
					updatedAt: appliedAt,
				})
				.where(
					and(
						eq(courseSyncPollState.bindingId, binding.bindingId),
						inArray(courseSyncPollState.status, ['awaiting-apply', 'applying']),
						eq(courseSyncPollState.controlPlaneRunId, runId),
					),
				)
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
				and(eq(courseSyncRun.runId, runId), ne(courseSyncRun.state, 'applied')),
			)
		const failed = await readRun(runId)
		if (!failed)
			throw new CourseSyncError('RUN_NOT_FOUND', 'Failed run disappeared.', 500)
		return failed
	},

	async rollbackAtomically({
		runId,
		bindingId,
		idempotencyKey,
		compensatingRunId,
		createdById,
	}) {
		await db.transaction(async (trx) => {
			const [lockedBinding] = await trx
				.select({ bindingId: courseSyncBinding.bindingId })
				.from(courseSyncBinding)
				.where(eq(courseSyncBinding.bindingId, bindingId))
				.for('update')
			const [original] = await trx
				.select()
				.from(courseSyncRun)
				.where(eq(courseSyncRun.runId, runId))
				.for('update')
			const [currentHead] = await trx
				.select({ runId: courseSyncRun.runId })
				.from(courseSyncRun)
				.where(
					and(
						eq(courseSyncRun.bindingId, bindingId),
						eq(courseSyncRun.state, 'applied'),
						isNull(courseSyncRun.rollbackOfRunId),
					),
				)
				.orderBy(desc(courseSyncRun.updatedAt))
				.limit(1)
				.for('update')
			if (
				!lockedBinding ||
				!original ||
				original.bindingId !== bindingId ||
				original.state !== 'applied' ||
				currentHead?.runId !== runId
			) {
				throw new CourseSyncError(
					'ROLLBACK_CONCURRENCY_CONFLICT',
					'The run is no longer applied.',
					409,
				)
			}
			const receipts = await trx
				.select()
				.from(courseSyncRunResourceVersion)
				.where(eq(courseSyncRunResourceVersion.runId, runId))
				.for('update')
			if (
				!original.plan ||
				receipts.length !== original.plan.resources.length
			) {
				throw new CourseSyncError(
					'ROLLBACK_RECEIPTS_INCOMPLETE',
					'Rollback receipts do not match the applied plan.',
					409,
					{ category: 'lifecycle_conflict', retryable: false },
				)
			}
			const resourceIds = receipts.map((receipt) => receipt.resourceId)
			const lockedResources = await trx
				.select()
				.from(contentResource)
				.where(inArray(contentResource.id, resourceIds))
				.for('update')
			const lockedRelations = await trx
				.select()
				.from(contentResourceResource)
				.where(inArray(contentResourceResource.resourceId, resourceIds))
				.for('update')
			const lockedVersions = await trx
				.select()
				.from(contentResourceVersion)
				.where(inArray(contentResourceVersion.resourceId, resourceIds))
				.for('update')
			const resourcesById = new Map(
				lockedResources.map((resource) => [resource.id, resource]),
			)
			const versionsById = new Map(
				lockedVersions.map((version) => [version.id, version]),
			)
			const versionsByResource = new Map<string, number>()
			for (const version of lockedVersions) {
				versionsByResource.set(
					version.resourceId,
					Math.max(
						versionsByResource.get(version.resourceId) ?? 0,
						version.versionNumber,
					),
				)
			}
			for (const receipt of receipts) {
				const planItem = original.plan.resources.find(
					(item) => item.targetResourceId === receipt.resourceId,
				)
				const current = resourcesById.get(receipt.resourceId)
				const appliedVersion = versionsById.get(
					receipt.contentResourceVersionId,
				)
				const relations = lockedRelations.filter(
					(relation) => relation.resourceId === receipt.resourceId,
				)
				const activeRelations = relations.filter(
					(relation) => relation.deletedAt === null,
				)
				const relationMatches = planItem?.detached
					? activeRelations.length === 0 &&
						relations.some(
							(relation) =>
								relation.resourceOfId === planItem.parentResourceId &&
								relation.position === planItem.position &&
								relation.deletedAt !== null,
						)
					: activeRelations.length === 1 &&
						activeRelations[0]?.resourceOfId === planItem?.parentResourceId &&
						activeRelations[0]?.position === planItem?.position
				if (
					!planItem ||
					!current ||
					!appliedVersion ||
					current.currentVersionId !== receipt.contentResourceVersionId ||
					stableJson(current.fields ?? {}) !==
						stableJson(appliedVersion.fields ?? {}) ||
					!relationMatches
				) {
					throw new CourseSyncError(
						'ROLLBACK_TARGET_CHANGED',
						'A resource pointer, fields, or relation changed after apply.',
						409,
						{ category: 'lifecycle_conflict', retryable: false },
					)
				}
			}
			const now = new Date()
			await trx.insert(courseSyncRun).values({
				runId: compensatingRunId,
				bindingId: original.bindingId,
				sourceRevisionId: original.sourceRevisionId,
				courseVersionId: original.courseVersionId,
				state: 'applying',
				stageIdempotencyKey: courseSyncRollbackStageIdempotencyKey(
					runId,
					idempotencyKey,
				),
				stageFingerprint: original.stageFingerprint,
				applyIdempotencyKey: idempotencyKey,
				rollbackOfRunId: runId,
				plan: original.plan,
				planSha256: original.planSha256,
				createdAt: now,
				updatedAt: now,
			})
			const rollbackVersions: Array<
				typeof contentResourceVersion.$inferInsert
			> = []
			const rollbackReceipts: Array<
				typeof courseSyncRunResourceVersion.$inferInsert
			> = []
			const relationRestorations: Array<
				typeof contentResourceResource.$inferInsert
			> = []
			const relationTombstones: Array<{
				resourceId: string
				parentResourceId: string
			}> = []
			const pointerRestorations: Array<typeof contentResource.$inferInsert> = []
			for (const receipt of receipts) {
				if (receipt.action === 'retain') continue
				const planItem = original.plan?.resources.find(
					(item) => item.targetResourceId === receipt.resourceId,
				)
				const current = resourcesById.get(receipt.resourceId)
				if (!current || !planItem) {
					throw new CourseSyncError(
						'ROLLBACK_RESOURCE_MISSING',
						'A rollback resource or plan item disappeared.',
						409,
					)
				}
				const parent = receipt.parentVersionId
					? versionsById.get(receipt.parentVersionId)
					: null
				const fields = resolveCourseSyncRollbackFields({
					action: planItem.action,
					sourceKind: planItem.sourceKind,
					currentFields: (current.fields ?? {}) as Record<string, unknown>,
					previousVersionFields: parent
						? ((parent.fields ?? {}) as Record<string, unknown>)
						: null,
					runId,
				})
				const versionId = `version~${sha256(stableJson({ compensatingRunId, resourceId: receipt.resourceId, fields }))}`
				rollbackVersions.push({
					id: versionId,
					resourceId: receipt.resourceId,
					parentVersionId: current.currentVersionId,
					versionNumber: (versionsByResource.get(receipt.resourceId) ?? 0) + 1,
					fields,
					createdById,
				})
				rollbackReceipts.push({
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
					relationRestorations.push({
						resourceOfId: receipt.previousParentResourceId,
						resourceId: receipt.resourceId,
						position: receipt.previousPosition,
						metadata: {
							bindingId: original.bindingId,
							rollbackOfRunId: runId,
						},
						deletedAt: planItem.previousDetached ? now : null,
					})
				}
				if (
					receipt.previousParentResourceId === null ||
					receipt.previousParentResourceId !== planItem.parentResourceId
				) {
					relationTombstones.push({
						resourceId: receipt.resourceId,
						parentResourceId: planItem.parentResourceId,
					})
				}
				pointerRestorations.push(
					courseSyncRollbackPointer({
						resourceId: receipt.resourceId,
						resourceType: current.type,
						createdById: current.createdById,
						versionId,
						fields,
					}),
				)
			}
			for (const batch of chunkCourseSyncWrites(rollbackVersions)) {
				await trx.insert(contentResourceVersion).values(batch)
			}
			for (const batch of chunkCourseSyncWrites(rollbackReceipts)) {
				await trx.insert(courseSyncRunResourceVersion).values(batch)
			}
			const preparedVersions =
				rollbackVersions.length === 0
					? []
					: await trx
							.select({ id: contentResourceVersion.id })
							.from(contentResourceVersion)
							.where(
								inArray(
									contentResourceVersion.id,
									rollbackVersions.map((version) => version.id),
								),
							)
			const preparedReceipts = await trx
				.select({ resourceId: courseSyncRunResourceVersion.resourceId })
				.from(courseSyncRunResourceVersion)
				.where(eq(courseSyncRunResourceVersion.runId, compensatingRunId))
			if (
				preparedVersions.length !== rollbackVersions.length ||
				preparedReceipts.length !== rollbackReceipts.length
			) {
				throw new CourseSyncError(
					'ROLLBACK_PREPARATION_COUNT_MISMATCH',
					'Prepared rollback rows do not match the compensating plan.',
					500,
					{ category: 'internal', retryable: false },
				)
			}
			for (const batch of chunkCourseSyncWrites(relationRestorations)) {
				await trx
					.insert(contentResourceResource)
					.values(batch)
					.onDuplicateKeyUpdate({
						set: {
							position: sql`values(${contentResourceResource.position})`,
							metadata: sql`values(${contentResourceResource.metadata})`,
							deletedAt: sql`values(${contentResourceResource.deletedAt})`,
							updatedAt: now,
						},
					})
			}
			for (const batch of chunkCourseSyncWrites(relationTombstones)) {
				await trx
					.update(contentResourceResource)
					.set({ deletedAt: now, updatedAt: now })
					.where(
						or(
							...batch.map((relation) =>
								and(
									eq(contentResourceResource.resourceId, relation.resourceId),
									eq(
										contentResourceResource.resourceOfId,
										relation.parentResourceId,
									),
								),
							),
						),
					)
			}
			for (const batch of chunkCourseSyncWrites(pointerRestorations)) {
				await trx
					.insert(contentResource)
					.values(batch)
					.onDuplicateKeyUpdate({
						set: {
							currentVersionId: sql`values(${contentResource.currentVersionId})`,
							fields: sql`values(${contentResource.fields})`,
							updatedAt: now,
						},
					})
			}
			const restoredResources =
				pointerRestorations.length === 0
					? []
					: await trx
							.select({
								id: contentResource.id,
								currentVersionId: contentResource.currentVersionId,
								fields: contentResource.fields,
							})
							.from(contentResource)
							.where(
								inArray(
									contentResource.id,
									pointerRestorations.map((resource) => resource.id),
								),
							)
			const expectedRestorations = new Map(
				pointerRestorations.map((resource) => [resource.id, resource]),
			)
			if (
				restoredResources.length !== pointerRestorations.length ||
				restoredResources.some((resource) => {
					const expected = expectedRestorations.get(resource.id)
					return (
						!expected ||
						resource.currentVersionId !== expected.currentVersionId ||
						stableJson(resource.fields ?? {}) !==
							stableJson(expected.fields ?? {})
					)
				})
			) {
				throw new CourseSyncError(
					'ROLLBACK_WRITE_VERIFICATION_FAILED',
					'Rollback pointer or denormalized fields did not match the restored version.',
					500,
					{ category: 'internal', retryable: false },
				)
			}
			await trx
				.update(courseSyncRun)
				.set({ state: 'applied', updatedAt: now })
				.where(eq(courseSyncRun.runId, compensatingRunId))
			await trx
				.update(courseSyncRun)
				.set({ state: 'rolled_back', compensatingRunId, updatedAt: now })
				.where(eq(courseSyncRun.runId, runId))
			await trx
				.update(courseSyncPollState)
				.set({
					status: 'held',
					consecutiveFailures: 1,
					controlPlaneRunId: runId,
					failureClass: 'APPLIED_RUN_ROLLED_BACK',
					updatedAt: now,
				})
				.where(eq(courseSyncPollState.bindingId, bindingId))
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
