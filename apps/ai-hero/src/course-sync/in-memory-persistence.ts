import { resolveStoredCourseSyncBinding } from './binding-migration'
import { CourseSyncError } from './errors'
import { resolveCourseSyncRollbackFields } from './persistence-invariants'
import {
	courseSyncRollbackStageIdempotencyKey,
	sha256,
	stableJson,
} from './control-plane'
import type {
	CourseSyncBinding,
	CourseSyncPersistence,
	SourceRevisionRecord,
	SyncRunRecord,
	TargetResourceSnapshot,
} from './types'

type MemoryVersion = {
	id: string
	resourceId: string
	parentVersionId: string | null
	versionNumber: number
	fields: Record<string, unknown>
}

type MemoryReceipt = {
	runId: string
	resourceId: string
	versionId: string
	parentVersionId: string | null
	previousParentResourceId: string | null
	previousPosition: number | null
	action: string
}

function cloneMap<T>(map: Map<string, T>): Map<string, T> {
	return new Map(
		[...map].map(([key, value]) => [key, structuredClone(value)] as const),
	)
}

function replaceMap<T>(target: Map<string, T>, source: Map<string, T>): void {
	target.clear()
	for (const [key, value] of source) target.set(key, value)
}

export class InMemoryCourseSyncPersistence implements CourseSyncPersistence {
	readonly bindings = new Map<string, CourseSyncBinding>()
	readonly revisions = new Map<string, SourceRevisionRecord>()
	readonly frozenAssetReceipts = new Map<
		string,
		SourceRevisionRecord['assets'][number]
	>()
	readonly runs = new Map<string, SyncRunRecord>()
	readonly resources = new Map<
		string,
		TargetResourceSnapshot & { type: string }
	>()
	readonly versions = new Map<string, MemoryVersion>()
	readonly receipts: MemoryReceipt[] = []
	readonly relations = new Map<
		string,
		{ parentId: string; childId: string; position: number; detached: boolean }
	>()
	targetValid = true
	assertTargetCalls = 0
	failAfterVersionWrites: number | null = null
	beforeApplyTargetRecheck: (() => void) | null = null
	currentAwaitingApplyRunId: string | null = null
	currentAppliedRunId: string | null = null

	async ensureBinding(binding: CourseSyncBinding) {
		const existing = this.bindings.get(binding.bindingId)
		const resolved = existing
			? resolveStoredCourseSyncBinding(existing, binding)
			: { binding, migrated: false }
		this.bindings.set(binding.bindingId, structuredClone(resolved.binding))
		return structuredClone(resolved.binding)
	}

	async getBinding(bindingId: string) {
		return structuredClone(this.bindings.get(bindingId) ?? null)
	}

	async assertTarget(_binding: CourseSyncBinding) {
		this.assertTargetCalls += 1
		if (!this.targetValid) {
			throw new CourseSyncError(
				'TARGET_CONTRACT_MISMATCH',
				'Target contract mismatch.',
				409,
				{ category: 'target_precondition', retryable: false },
			)
		}
	}

	async findRunByStageKey(bindingId: string, key: string) {
		return structuredClone(
			[...this.runs.values()].find(
				(run) => run.bindingId === bindingId && run.stageIdempotencyKey === key,
			) ?? null,
		)
	}

	async findAppliedRunByRevision(bindingId: string, courseVersionId: string) {
		return structuredClone(
			[...this.runs.values()].find(
				(run) =>
					run.bindingId === bindingId &&
					run.courseVersionId === courseVersionId &&
					run.state === 'applied' &&
					!run.rollbackOfRunId,
			) ?? null,
		)
	}

	async findFrozenAsset(
		bindingId: string,
		producerSha256: string,
		bytes: number,
	) {
		for (const revision of [...this.revisions.values()].reverse()) {
			if (revision.bindingId !== bindingId) continue
			const asset = revision.assets.find(
				(candidate) =>
					candidate.producerSha256 === producerSha256 &&
					candidate.bytes === bytes,
			)
			if (asset) return structuredClone(asset)
		}
		return null
	}

	async findFrozenAssetReceipt(receiptKey: string) {
		return structuredClone(this.frozenAssetReceipts.get(receiptKey) ?? null)
	}

	async saveFrozenAssetReceipt(input: {
		receiptKey: string
		bindingId: string
		courseVersionId: string
		asset: SourceRevisionRecord['assets'][number]
	}) {
		const existing = this.frozenAssetReceipts.get(input.receiptKey)
		if (existing) {
			if (existing.muxAssetId === input.asset.muxAssetId) {
				const completed = {
					...existing,
					muxPlaybackId: input.asset.muxPlaybackId,
					duration: input.asset.duration,
				}
				this.frozenAssetReceipts.set(input.receiptKey, completed)
				return structuredClone(completed)
			}
			return structuredClone(existing)
		}
		const stored = structuredClone(input.asset)
		delete stored.freezeEffects
		this.frozenAssetReceipts.set(input.receiptKey, stored)
		return structuredClone(stored)
	}

	async createStaged(input: {
		revision: SourceRevisionRecord
		run: SyncRunRecord
	}) {
		this.revisions.set(
			input.revision.sourceRevisionId,
			structuredClone(input.revision),
		)
		this.runs.set(input.run.runId, structuredClone(input.run))
		return structuredClone(input.run)
	}

	async getRun(runId: string) {
		return structuredClone(this.runs.get(runId) ?? null)
	}

	async getRevision(sourceRevisionId: string) {
		return structuredClone(this.revisions.get(sourceRevisionId) ?? null)
	}

	async getLastAppliedRun(bindingId: string) {
		return structuredClone(
			[...this.runs.values()]
				.filter(
					(run) =>
						run.bindingId === bindingId &&
						run.state === 'applied' &&
						!run.rollbackOfRunId,
				)
				.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ??
				null,
		)
	}

	async getTargetResources(resourceIds: ReadonlyArray<string>) {
		return new Map(
			resourceIds.flatMap((resourceId) => {
				const resource = this.resources.get(resourceId)
				return resource
					? [[resourceId, structuredClone(resource)] as const]
					: []
			}),
		)
	}

	async savePreview(runId: string, plan: NonNullable<SyncRunRecord['plan']>) {
		const previousAwaitingRunId = this.currentAwaitingApplyRunId
		if (previousAwaitingRunId && previousAwaitingRunId !== runId) {
			const previous = this.runs.get(previousAwaitingRunId)
			if (previous?.state === 'previewed') {
				this.runs.set(previousAwaitingRunId, {
					...previous,
					state: 'superseded',
					updatedAt: new Date(previous.updatedAt.getTime() + 1),
				})
			}
		}
		const run = this.runs.get(runId)
		if (!run || run.state !== 'staged') {
			throw new CourseSyncError(
				'PREVIEW_CONCURRENCY_CONFLICT',
				'Run changed.',
				409,
			)
		}
		const updated = {
			...run,
			state: 'previewed' as const,
			plan: structuredClone(plan),
			planSha256: plan.planSha256,
			updatedAt: new Date(run.updatedAt.getTime() + 1),
		}
		this.runs.set(runId, updated)
		this.currentAwaitingApplyRunId = runId
		return structuredClone(updated)
	}

	async applyAtomically(input: {
		runId: string
		plan: NonNullable<SyncRunRecord['plan']>
		idempotencyKey: string
		createdById: string
	}) {
		const current = this.runs.get(input.runId)
		const { planSha256: claimedPlanSha256, ...planInput } = input.plan
		if (
			!current ||
			this.currentAwaitingApplyRunId !== input.runId ||
			(current.state !== 'previewed' && current.state !== 'failed') ||
			current.planSha256 !== input.plan.planSha256 ||
			claimedPlanSha256 !== sha256(stableJson(planInput)) ||
			stableJson(current.plan) !== stableJson(input.plan)
		) {
			throw new CourseSyncError(
				'APPLY_CONCURRENCY_CONFLICT',
				'Run or content-addressed plan changed.',
				409,
			)
		}
		if (
			current.state === 'failed' &&
			current.applyIdempotencyKey &&
			current.applyIdempotencyKey !== input.idempotencyKey
		) {
			throw new CourseSyncError(
				'IDEMPOTENCY_CONFLICT',
				'Failed apply retry used another idempotency key.',
				409,
			)
		}
		this.beforeApplyTargetRecheck?.()
		const binding = this.bindings.get(input.plan.bindingId)
		if (!binding) {
			throw new CourseSyncError('BINDING_NOT_FOUND', 'Binding missing.', 409)
		}
		await this.assertTarget(binding)
		const run: SyncRunRecord = {
			...current,
			state: 'applying',
			applyIdempotencyKey: input.idempotencyKey,
			failureCode: null,
			failureReason: null,
		}
		this.runs.set(input.runId, structuredClone(run))
		const resources = cloneMap(this.resources)
		const versions = cloneMap(this.versions)
		const relations = cloneMap(this.relations)
		const receipts = structuredClone(this.receipts)
		const pointers: Array<{ resourceId: string; versionId: string }> = []
		let writes = 0
		for (const item of input.plan.resources) {
			let resource = resources.get(item.targetResourceId)
			if (item.action === 'create') {
				if (resource)
					throw new CourseSyncError(
						'RESOURCE_ALREADY_EXISTS',
						'Resource exists.',
						409,
					)
				resource = {
					resourceId: item.targetResourceId,
					currentVersionId: null,
					fields: structuredClone(item.fields),
					type: item.sourceKind === 'video' ? 'videoResource' : item.sourceKind,
				}
				resources.set(item.targetResourceId, resource)
				relations.set(item.targetResourceId, {
					parentId: item.parentResourceId,
					childId: item.targetResourceId,
					position: item.position,
					// Honor the plan rather than assuming attached. Recreating a
					// question that was previously removed arrives as create +
					// detached: true, and hard-coding false would silently make it
					// visible again.
					detached: item.detached,
				})
			}
			if (!resource)
				throw new CourseSyncError(
					'MANAGED_RESOURCE_MISSING',
					'Resource missing.',
					409,
				)
			if (item.action !== 'create') {
				if (sha256(stableJson(resource.fields)) !== item.previousFieldsSha256) {
					throw new CourseSyncError(
						'APPLY_TARGET_CHANGED',
						'Resource fields changed after preview.',
						409,
					)
				}
				const relation = relations.get(item.targetResourceId)
				if (
					!relation ||
					relation.detached !== item.previousDetached ||
					relation.parentId !==
						(item.previousParentResourceId ?? item.parentResourceId) ||
					relation.position !== (item.previousPosition ?? item.position)
				) {
					throw new CourseSyncError(
						'MANAGED_RELATION_MISSING',
						'Relation missing or detached state changed.',
						409,
					)
				}
				relation.parentId = item.parentResourceId
				relation.position = item.position
				relation.detached = item.detached
			}
			if (item.action === 'retain') {
				if (!resource.currentVersionId)
					throw new CourseSyncError(
						'RETAINED_VERSION_MISSING',
						'Version missing.',
						409,
					)
				receipts.push({
					runId: input.runId,
					resourceId: item.targetResourceId,
					versionId: resource.currentVersionId,
					parentVersionId: resource.currentVersionId,
					previousParentResourceId: item.previousParentResourceId,
					previousPosition: item.previousPosition,
					action: 'retain',
				})
				continue
			}
			const priorVersions = [...versions.values()].filter(
				(version) => version.resourceId === item.targetResourceId,
			)
			const versionId = `version~${sha256(
				stableJson({
					runId: input.runId,
					resourceId: item.targetResourceId,
					fields: item.fields,
				}),
			)}`
			versions.set(versionId, {
				id: versionId,
				resourceId: item.targetResourceId,
				parentVersionId: resource.currentVersionId,
				versionNumber: priorVersions.length + 1,
				fields: structuredClone(item.fields),
			})
			receipts.push({
				runId: input.runId,
				resourceId: item.targetResourceId,
				versionId,
				parentVersionId: resource.currentVersionId,
				previousParentResourceId: item.previousParentResourceId,
				previousPosition: item.previousPosition,
				action: item.action,
			})
			pointers.push({ resourceId: item.targetResourceId, versionId })
			writes += 1
			if (
				this.failAfterVersionWrites !== null &&
				writes >= this.failAfterVersionWrites
			) {
				throw new CourseSyncError(
					'INJECTED_APPLY_FAILURE',
					'Injected apply failure.',
					500,
				)
			}
		}
		for (const pointer of pointers) {
			const resource = resources.get(pointer.resourceId)
			const version = versions.get(pointer.versionId)
			if (!resource || !version) {
				throw new CourseSyncError(
					'POINTER_PROMOTION_FAILED',
					'A prepared resource version disappeared before promotion.',
					500,
				)
			}
			resource.currentVersionId = pointer.versionId
			resource.fields = structuredClone(version.fields)
		}
		this.resources.clear()
		resources.forEach((value, key) => this.resources.set(key, value))
		this.versions.clear()
		versions.forEach((value, key) => this.versions.set(key, value))
		this.relations.clear()
		relations.forEach((value, key) => this.relations.set(key, value))
		this.receipts.splice(0, this.receipts.length, ...receipts)
		const applied = {
			...run,
			state: 'applied' as const,
			applyIdempotencyKey: input.idempotencyKey,
			updatedAt: new Date(run.updatedAt.getTime() + 1),
		}
		this.runs.set(input.runId, applied)
		this.currentAwaitingApplyRunId = null
		this.currentAppliedRunId = input.runId
		return structuredClone(applied)
	}

	async markFailed(
		runId: string,
		code: string,
		reason: string,
		applyIdempotencyKey: string,
	) {
		const run = this.runs.get(runId)
		if (!run) throw new CourseSyncError('RUN_NOT_FOUND', 'Run missing.', 500)
		const failed = {
			...run,
			state: 'failed' as const,
			applyIdempotencyKey,
			failureCode: code,
			failureReason: reason,
			updatedAt: new Date(run.updatedAt.getTime() + 1),
		}
		this.runs.set(runId, failed)
		return structuredClone(failed)
	}

	async rollbackAtomically(input: {
		runId: string
		bindingId: string
		idempotencyKey: string
		compensatingRunId: string
		createdById: string
	}) {
		const original = this.runs.get(input.runId)
		if (
			!original ||
			original.state !== 'applied' ||
			this.currentAppliedRunId !== input.runId
		) {
			throw new CourseSyncError(
				'ROLLBACK_CONCURRENCY_CONFLICT',
				'Run changed.',
				409,
			)
		}
		const runReceipts = this.receipts.filter(
			(receipt) => receipt.runId === input.runId,
		)
		for (const receipt of runReceipts) {
			const planItem = original.plan?.resources.find(
				(item) => item.targetResourceId === receipt.resourceId,
			)
			const resource = this.resources.get(receipt.resourceId)
			const relation = this.relations.get(receipt.resourceId)
			if (
				!planItem ||
				!resource ||
				resource.currentVersionId !== receipt.versionId ||
				!relation ||
				relation.parentId !== planItem.parentResourceId ||
				relation.position !== planItem.position ||
				relation.detached !== planItem.detached
			) {
				throw new CourseSyncError(
					'ROLLBACK_TARGET_CHANGED',
					'A resource or relation changed after this run applied.',
					409,
				)
			}
		}
		const nextRuns = cloneMap(this.runs)
		const nextResources = cloneMap(this.resources)
		const nextVersions = cloneMap(this.versions)
		const nextRelations = cloneMap(this.relations)
		const nextReceipts = structuredClone(this.receipts)
		const nextVersionNumbers = new Map<string, number>()

		// Resolve every lookup, restored field payload, version, relation, and
		// receipt against cloned state. Nothing observable changes until every
		// rollback operation has prepared successfully.
		const plannedRollbacks = runReceipts
			.filter((receipt) => receipt.action !== 'retain')
			.map((receipt) => {
				const planItem = original.plan?.resources.find(
					(item) => item.targetResourceId === receipt.resourceId,
				)
				if (!planItem) {
					throw new CourseSyncError(
						'ROLLBACK_PLAN_ITEM_MISSING',
						`No plan item found for resource ${receipt.resourceId} during rollback.`,
						409,
					)
				}
				const resource = nextResources.get(receipt.resourceId)
				if (!resource) {
					throw new CourseSyncError(
						'ROLLBACK_RESOURCE_MISSING',
						'A rollback resource disappeared.',
						409,
					)
				}
				const parent = receipt.parentVersionId
					? nextVersions.get(receipt.parentVersionId)
					: null
				const fields = resolveCourseSyncRollbackFields({
					action: planItem.action,
					sourceKind: planItem.sourceKind,
					currentFields: resource.fields,
					previousVersionFields: parent?.fields ?? null,
					runId: input.runId,
				})
				const versionId = `version~${sha256(
					stableJson({
						compensatingRunId: input.compensatingRunId,
						resourceId: receipt.resourceId,
						fields,
					}),
				)}`
				const previousVersionNumber =
					nextVersionNumbers.get(receipt.resourceId) ??
					Math.max(
						0,
						...[...nextVersions.values()]
							.filter((version) => version.resourceId === receipt.resourceId)
							.map((version) => version.versionNumber),
					)
				const versionNumber = previousVersionNumber + 1
				nextVersionNumbers.set(receipt.resourceId, versionNumber)
				return {
					resourceId: receipt.resourceId,
					version: {
						id: versionId,
						resourceId: receipt.resourceId,
						parentVersionId: resource.currentVersionId,
						versionNumber,
						fields: structuredClone(fields),
					},
					fields: structuredClone(fields),
					relation:
						receipt.previousParentResourceId !== null &&
						receipt.previousPosition !== null
							? {
									parentId: receipt.previousParentResourceId,
									childId: receipt.resourceId,
									position: receipt.previousPosition,
									detached: planItem.previousDetached,
								}
							: {
									parentId: planItem.parentResourceId,
									childId: receipt.resourceId,
									position: planItem.position,
									detached: true,
								},
					receipt: {
						runId: input.compensatingRunId,
						resourceId: receipt.resourceId,
						versionId,
						parentVersionId: receipt.versionId,
						previousParentResourceId: null,
						previousPosition: null,
						action: 'update',
					},
				}
			})

		for (const rollback of plannedRollbacks) {
			nextVersions.set(rollback.version.id, rollback.version)
			const resource = nextResources.get(rollback.resourceId)
			if (!resource) {
				throw new CourseSyncError(
					'ROLLBACK_RESOURCE_MISSING',
					'A prepared rollback resource disappeared from cloned state.',
					409,
				)
			}
			resource.currentVersionId = rollback.version.id
			resource.fields = rollback.fields
			nextRelations.set(rollback.resourceId, rollback.relation)
			nextReceipts.push(rollback.receipt)
		}
		const compensating: SyncRunRecord = {
			...structuredClone(original),
			runId: input.compensatingRunId,
			state: 'applied',
			stageIdempotencyKey: courseSyncRollbackStageIdempotencyKey(
				input.runId,
				input.idempotencyKey,
			),
			applyIdempotencyKey: input.idempotencyKey,
			rollbackOfRunId: input.runId,
			compensatingRunId: null,
		}
		nextRuns.set(compensating.runId, compensating)
		const rolledBack: SyncRunRecord = {
			...structuredClone(original),
			state: 'rolled_back',
			compensatingRunId: compensating.runId,
		}
		nextRuns.set(input.runId, rolledBack)

		replaceMap(this.runs, nextRuns)
		replaceMap(this.resources, nextResources)
		replaceMap(this.versions, nextVersions)
		replaceMap(this.relations, nextRelations)
		this.receipts.splice(0, this.receipts.length, ...nextReceipts)
		this.currentAppliedRunId = null
		return structuredClone(rolledBack)
	}
}
