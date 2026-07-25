import { CourseSyncError } from './errors'
import { sha256, stableJson } from './control-plane'
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

export class InMemoryCourseSyncPersistence implements CourseSyncPersistence {
	readonly bindings = new Map<string, CourseSyncBinding>()
	readonly revisions = new Map<string, SourceRevisionRecord>()
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

	async ensureBinding(binding: CourseSyncBinding) {
		const existing = this.bindings.get(binding.bindingId)
		if (existing && stableJson(existing) !== stableJson(binding)) {
			throw new CourseSyncError(
				'IMMUTABLE_BINDING_CONFLICT',
				'Binding changed.',
				409,
			)
		}
		this.bindings.set(binding.bindingId, structuredClone(binding))
		return structuredClone(binding)
	}

	async getBinding(bindingId: string) {
		return structuredClone(this.bindings.get(bindingId) ?? null)
	}

	async assertTarget(_binding: CourseSyncBinding) {
		this.assertTargetCalls += 1
		if (!this.targetValid) {
			throw new CourseSyncError(
				'TARGET_ASSERTION_FAILED',
				'Target scope is invalid.',
				409,
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
		return structuredClone(updated)
	}

	async applyAtomically(input: {
		runId: string
		plan: NonNullable<SyncRunRecord['plan']>
		idempotencyKey: string
		createdById: string
	}) {
		const current = this.runs.get(input.runId)
		if (
			!current ||
			(current.state !== 'previewed' && current.state !== 'failed') ||
			current.planSha256 !== input.plan.planSha256
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
					type: item.sourceKind,
				}
				resources.set(item.targetResourceId, resource)
				relations.set(item.targetResourceId, {
					parentId: item.parentResourceId,
					childId: item.targetResourceId,
					position: item.position,
					detached: false,
				})
			}
			if (!resource)
				throw new CourseSyncError(
					'MANAGED_RESOURCE_MISSING',
					'Resource missing.',
					409,
				)
			if (item.action !== 'create') {
				const relation = relations.get(item.targetResourceId)
				if (!relation || relation.detached !== item.previousDetached) {
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
		idempotencyKey: string
		compensatingRunId: string
		createdById: string
	}) {
		const original = this.runs.get(input.runId)
		if (!original || original.state !== 'applied') {
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
			if (receipt.action === 'retain') continue
			const planItem = original.plan?.resources.find(
				(item) => item.targetResourceId === receipt.resourceId,
			)
			const resource = this.resources.get(receipt.resourceId)
			if (!resource) {
				throw new CourseSyncError(
					'ROLLBACK_RESOURCE_MISSING',
					'A rollback resource disappeared.',
					409,
				)
			}
			const parent = receipt.parentVersionId
				? this.versions.get(receipt.parentVersionId)
				: null
			const fields = parent?.fields ?? {
				...resource.fields,
				state: 'draft',
				visibility: 'unlisted',
				courseSync: {
					...((resource.fields.courseSync as
						| Record<string, unknown>
						| undefined) ?? {}),
					active: false,
					rollbackOfRunId: input.runId,
				},
			}
			const versionId = `version~${sha256(
				stableJson({
					compensatingRunId: input.compensatingRunId,
					resourceId: receipt.resourceId,
					fields,
				}),
			)}`
			const count = [...this.versions.values()].filter(
				(version) => version.resourceId === receipt.resourceId,
			).length
			this.versions.set(versionId, {
				id: versionId,
				resourceId: receipt.resourceId,
				parentVersionId: resource.currentVersionId,
				versionNumber: count + 1,
				fields: structuredClone(fields),
			})
			resource.currentVersionId = versionId
			resource.fields = structuredClone(fields)
			if (
				receipt.previousParentResourceId !== null &&
				receipt.previousPosition !== null
			) {
				this.relations.set(receipt.resourceId, {
					parentId: receipt.previousParentResourceId,
					childId: receipt.resourceId,
					position: receipt.previousPosition,
					detached: planItem?.previousDetached ?? false,
				})
			}
			this.receipts.push({
				runId: input.compensatingRunId,
				resourceId: receipt.resourceId,
				versionId,
				parentVersionId: receipt.versionId,
				previousParentResourceId: null,
				previousPosition: null,
				action: 'update',
			})
		}
		const compensating: SyncRunRecord = {
			...structuredClone(original),
			runId: input.compensatingRunId,
			state: 'applied',
			stageIdempotencyKey: `rollback:${input.runId}:${input.idempotencyKey}`,
			applyIdempotencyKey: input.idempotencyKey,
			rollbackOfRunId: input.runId,
			compensatingRunId: null,
		}
		this.runs.set(compensating.runId, compensating)
		const rolledBack: SyncRunRecord = {
			...original,
			state: 'rolled_back',
			compensatingRunId: compensating.runId,
		}
		this.runs.set(input.runId, rolledBack)
		return structuredClone(rolledBack)
	}
}
