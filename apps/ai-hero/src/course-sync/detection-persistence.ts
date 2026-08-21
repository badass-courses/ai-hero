import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import {
	contentResource,
	contentResourceProduct,
	contentResourceResource,
	courseSyncBinding,
	courseSyncPollLog,
	courseSyncPollState,
	courseSyncRun,
	courseSyncSourceRevision,
	products,
} from '@/db/schema'
import { log } from '@/server/logger'
import { and, desc, eq, isNull, ne } from 'drizzle-orm'

import { resolveStoredCourseSyncBinding } from './binding-migration'
import { sha256, stableJson } from './control-plane'
import type {
	CourseSyncPollLogInput,
	CourseSyncPollState,
	CourseSyncRevisionHead,
} from './detection-poller'
import { CourseSyncError } from './errors'
import { courseSyncApplyPolicyOverride } from './poll-policy'
import { canAutomaticallySaveCourseSyncPollState } from './poll-state-guard'
import {
	releasedCourseSyncPollState,
	type CourseSyncPollReleaseInput,
} from './release'
import { assertCourseSyncTargetContract } from './target-contract'
import { AI_HERO_COURSE_SYNC_BINDING } from './types'

export function courseSyncRevisionHeadWhere(bindingId: string) {
	// Failed runs (including discarded verification artifacts) never advanced
	// the sync frontier, so they must not become the revision head and mask
	// the latest applied revision from the poller's already-applied check.
	return and(
		eq(courseSyncSourceRevision.bindingId, bindingId),
		isNull(courseSyncRun.rollbackOfRunId),
		ne(courseSyncRun.state, 'failed'),
	)
}

export async function getCourseSyncRevisionHead(
	bindingId: string,
): Promise<CourseSyncRevisionHead | null> {
	const [[row], previousApplied] = await Promise.all([
		db
			.select({
				courseVersionId: courseSyncSourceRevision.courseVersionId,
				providerRevision: courseSyncSourceRevision.providerRevision,
				runId: courseSyncRun.runId,
				runState: courseSyncRun.state,
			})
			.from(courseSyncSourceRevision)
			.innerJoin(
				courseSyncRun,
				eq(
					courseSyncRun.sourceRevisionId,
					courseSyncSourceRevision.sourceRevisionId,
				),
			)
			.where(courseSyncRevisionHeadWhere(bindingId))
			.orderBy(
				desc(courseSyncSourceRevision.stagedAt),
				desc(courseSyncRun.updatedAt),
			)
			.limit(1),
		db.query.courseSyncRun.findFirst({
			columns: { runId: true },
			where: and(
				eq(courseSyncRun.bindingId, bindingId),
				eq(courseSyncRun.state, 'applied'),
				isNull(courseSyncRun.rollbackOfRunId),
			),
			orderBy: desc(courseSyncRun.updatedAt),
		}),
	])

	return row
		? {
				...row,
				runState: row.runState as CourseSyncRevisionHead['runState'],
				previousAppliedRunId: previousApplied?.runId ?? null,
			}
		: null
}

export async function getCourseSyncPollState(
	bindingId: string,
): Promise<CourseSyncPollState | null> {
	const row = await db.query.courseSyncPollState.findFirst({
		where: eq(courseSyncPollState.bindingId, bindingId),
	})
	return row
		? {
				...row,
				status: row.status as CourseSyncPollState['status'],
				applyPolicyOverride:
					row.applyPolicyOverride as CourseSyncPollState['applyPolicyOverride'],
			}
		: null
}

export async function saveCourseSyncPollState(state: CourseSyncPollState) {
	await db.transaction(async (trx) => {
		await trx
			.select({ bindingId: courseSyncBinding.bindingId })
			.from(courseSyncBinding)
			.where(eq(courseSyncBinding.bindingId, state.bindingId))
			.for('update')
		const [current] = await trx
			.select()
			.from(courseSyncPollState)
			.where(eq(courseSyncPollState.bindingId, state.bindingId))
			.for('update')
		const currentState: CourseSyncPollState | null = current
			? {
					...current,
					status: current.status as CourseSyncPollState['status'],
					applyPolicyOverride:
						current.applyPolicyOverride as CourseSyncPollState['applyPolicyOverride'],
				}
			: null
		if (!canAutomaticallySaveCourseSyncPollState(currentState, state)) return
		const nextState: CourseSyncPollState = {
			...state,
			applyPolicyOverride:
				state.status === 'succeeded'
					? null
					: (courseSyncApplyPolicyOverride(currentState) ??
						state.applyPolicyOverride),
		}
		if (
			current?.status === 'awaiting-apply' &&
			current.controlPlaneRunId &&
			(((state.status === 'batching' || state.status === 'staging') &&
				(state.courseVersionId !== current.courseVersionId ||
					state.providerRevision !== current.providerRevision)) ||
				(state.status === 'awaiting-apply' &&
					state.controlPlaneRunId &&
					current.controlPlaneRunId !== state.controlPlaneRunId))
		) {
			await trx
				.update(courseSyncRun)
				.set({ state: 'superseded', updatedAt: state.updatedAt })
				.where(
					and(
						eq(courseSyncRun.runId, current.controlPlaneRunId),
						eq(courseSyncRun.state, 'previewed'),
					),
				)
		}
		await trx
			.insert(courseSyncPollState)
			.values(nextState)
			.onDuplicateKeyUpdate({
				set: {
					courseVersionId: nextState.courseVersionId,
					providerRevision: nextState.providerRevision,
					status: nextState.status,
					consecutiveFailures: nextState.consecutiveFailures,
					controlPlaneRunId: nextState.controlPlaneRunId,
					failureClass: nextState.failureClass,
					applyPolicyOverride: nextState.applyPolicyOverride,
					updatedAt: nextState.updatedAt,
				},
			})
	})
}

export type CourseSyncReviewNotificationReceiptInput = {
	bindingId: string
	courseVersionId: string
	providerRevision: string
	runId: string
	controlPlaneRunId: string
	planSha256: string
	occurredAt: Date
}

function courseSyncReviewNotificationReceipt(input: {
	bindingId: string
	courseVersionId: string
	planSha256: string
}) {
	const notificationKey = sha256(
		stableJson({
			kind: 'review',
			bindingId: input.bindingId,
			courseVersionId: input.courseVersionId,
			planSha256: input.planSha256,
		}),
	)
	return {
		notificationKey,
		receiptId: `cspl_review_notice_${notificationKey}`,
	}
}

export async function claimCourseSyncReviewNotification(
	input: CourseSyncReviewNotificationReceiptInput,
): Promise<boolean> {
	const { notificationKey, receiptId } =
		courseSyncReviewNotificationReceipt(input)
	return db.transaction(async (trx) => {
		await trx
			.select({ bindingId: courseSyncBinding.bindingId })
			.from(courseSyncBinding)
			.where(eq(courseSyncBinding.bindingId, input.bindingId))
			.for('update')
		const [existing] = await trx
			.select({
				id: courseSyncPollLog.id,
				outcome: courseSyncPollLog.outcome,
				metadata: courseSyncPollLog.metadata,
			})
			.from(courseSyncPollLog)
			.where(eq(courseSyncPollLog.id, receiptId))
			.for('update')
		if (
			existing?.outcome === 'succeeded' ||
			existing?.outcome === 'started'
		) {
			return false
		}
		if (existing) {
			const deliveryAttempts = Number(
				(existing.metadata?.deliveryAttempts as number | undefined) ?? 1,
			)
			await trx
				.update(courseSyncPollLog)
				.set({
					runId: input.runId,
					controlPlaneRunId: input.controlPlaneRunId,
					outcome: 'started',
					failureClass: null,
					metadata: {
						...existing.metadata,
						deliveryAttempts: deliveryAttempts + 1,
					},
					occurredAt: input.occurredAt,
				})
				.where(eq(courseSyncPollLog.id, receiptId))
			return true
		}
		await trx.insert(courseSyncPollLog).values({
			id: receiptId,
			bindingId: input.bindingId,
			courseVersionId: input.courseVersionId,
			providerRevision: input.providerRevision,
			runId: input.runId,
			controlPlaneRunId: input.controlPlaneRunId,
			stage: 'notify',
			outcome: 'started',
			failureClass: null,
			metadata: {
				kind: 'review',
				notificationKey,
				planSha256: input.planSha256,
				deliveryAttempts: 1,
			},
			occurredAt: input.occurredAt,
		})
		return true
	})
}

export async function completeCourseSyncReviewNotification(
	input: CourseSyncReviewNotificationReceiptInput,
): Promise<void> {
	const { receiptId } = courseSyncReviewNotificationReceipt(input)
	await db.transaction(async (trx) => {
		await trx
			.select({ bindingId: courseSyncBinding.bindingId })
			.from(courseSyncBinding)
			.where(eq(courseSyncBinding.bindingId, input.bindingId))
			.for('update')
		const [existing] = await trx
			.select({
				id: courseSyncPollLog.id,
				outcome: courseSyncPollLog.outcome,
				metadata: courseSyncPollLog.metadata,
			})
			.from(courseSyncPollLog)
			.where(eq(courseSyncPollLog.id, receiptId))
			.for('update')
		if (!existing) {
			throw new CourseSyncError(
				'REVIEW_NOTIFICATION_RECEIPT_MISSING',
				'Cannot complete a review notification without its durable claim.',
				409,
				{ category: 'lifecycle_conflict', retryable: true },
			)
		}
		if (existing.outcome === 'succeeded') return
		await trx
			.update(courseSyncPollLog)
			.set({
				outcome: 'succeeded',
				metadata: {
					...existing.metadata,
					deliveredAt: input.occurredAt.toISOString(),
				},
				occurredAt: input.occurredAt,
			})
			.where(eq(courseSyncPollLog.id, receiptId))
	})
}

export async function failCourseSyncReviewNotification(
	input: CourseSyncReviewNotificationReceiptInput & { failureClass: string },
): Promise<void> {
	const { receiptId } = courseSyncReviewNotificationReceipt(input)
	await db.transaction(async (trx) => {
		await trx
			.select({ bindingId: courseSyncBinding.bindingId })
			.from(courseSyncBinding)
			.where(eq(courseSyncBinding.bindingId, input.bindingId))
			.for('update')
		const [existing] = await trx
			.select({
				id: courseSyncPollLog.id,
				outcome: courseSyncPollLog.outcome,
				metadata: courseSyncPollLog.metadata,
			})
			.from(courseSyncPollLog)
			.where(eq(courseSyncPollLog.id, receiptId))
			.for('update')
		if (!existing || existing.outcome === 'succeeded') return
		await trx
			.update(courseSyncPollLog)
			.set({
				outcome: 'failed',
				failureClass: input.failureClass,
				metadata: {
					...existing.metadata,
					failedAt: input.occurredAt.toISOString(),
				},
				occurredAt: input.occurredAt,
			})
			.where(eq(courseSyncPollLog.id, receiptId))
	})
}

export async function releaseCourseSyncPollHoldAtomically(
	input: CourseSyncPollReleaseInput,
): Promise<CourseSyncPollState> {
	const receiptId = `cspl_release_${sha256(input.operationId)}`
	const requestHash = sha256(
		stableJson({
			bindingId: input.bindingId,
			actor: input.actor,
			reason: input.reason,
		}),
	)
	return db.transaction(async (trx) => {
		const [storedBinding] = await trx
			.select()
			.from(courseSyncBinding)
			.where(eq(courseSyncBinding.bindingId, input.bindingId))
			.for('update')
		if (!storedBinding) {
			throw new CourseSyncError(
				'BINDING_NOT_FOUND',
				'Course sync binding was not found.',
				404,
				{ category: 'lifecycle_conflict', retryable: false },
			)
		}
		const binding = resolveStoredCourseSyncBinding(
			storedBinding.binding,
			AI_HERO_COURSE_SYNC_BINDING,
		).binding

		const [priorReceipt] = await trx
			.select()
			.from(courseSyncPollLog)
			.where(eq(courseSyncPollLog.id, receiptId))
			.for('update')
		if (priorReceipt) {
			const metadata = priorReceipt.metadata ?? {}
			if (metadata.requestHash !== requestHash) {
				throw new CourseSyncError(
					'IDEMPOTENCY_CONFLICT',
					'The release idempotency key was used with different input.',
					409,
					{ category: 'lifecycle_conflict', retryable: false },
				)
			}
			const value = metadata.releasedState
			if (!value || typeof value !== 'object') {
				throw new CourseSyncError(
					'RELEASE_RECEIPT_INVALID',
					'The durable release receipt is incomplete.',
					500,
					{ category: 'internal', retryable: false },
				)
			}
			const releasedState = value as Omit<CourseSyncPollState, 'updatedAt'> & {
				updatedAt: string | Date
			}
			const replayedState: CourseSyncPollState = {
				...releasedState,
				status: releasedState.status,
				applyPolicyOverride:
					releasedState.applyPolicyOverride === 'operator'
						? 'operator'
						: releasedState.status === 'released'
							? 'operator'
							: null,
				updatedAt: new Date(releasedState.updatedAt),
			}
			return replayedState
		}

		const [lockedState] = await trx
			.select()
			.from(courseSyncPollState)
			.where(eq(courseSyncPollState.bindingId, input.bindingId))
			.for('update')
		if (!lockedState) {
			throw new CourseSyncError(
				'POLL_STATE_NOT_FOUND',
				'Course sync poll state was not found.',
				404,
				{ category: 'lifecycle_conflict', retryable: false },
			)
		}
		const currentState: CourseSyncPollState = {
			...lockedState,
			status: lockedState.status as CourseSyncPollState['status'],
			applyPolicyOverride:
				lockedState.applyPolicyOverride as CourseSyncPollState['applyPolicyOverride'],
		}
		const released = releasedCourseSyncPollState(currentState, input.occurredAt)

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

		await trx.insert(courseSyncPollLog).values({
			id: receiptId,
			bindingId: input.bindingId,
			courseVersionId: currentState.courseVersionId,
			providerRevision: currentState.providerRevision,
			runId: input.operationId,
			controlPlaneRunId: null,
			stage: 'release',
			outcome: 'succeeded',
			failureClass: null,
			metadata: {
				requestHash,
				actor: input.actor,
				reason: input.reason,
				previousStatus: currentState.status,
				previousFailureClass: currentState.failureClass,
				previousControlPlaneRunId: currentState.controlPlaneRunId,
				releasedState: {
					...released,
					updatedAt: released.updatedAt.toISOString(),
				},
			},
			occurredAt: input.occurredAt,
		})
		await trx
			.update(courseSyncPollState)
			.set({
				status: released.status,
				consecutiveFailures: released.consecutiveFailures,
				controlPlaneRunId: released.controlPlaneRunId,
				failureClass: released.failureClass,
				applyPolicyOverride: released.applyPolicyOverride,
				updatedAt: released.updatedAt,
			})
			.where(
				and(
					eq(courseSyncPollState.bindingId, input.bindingId),
					eq(courseSyncPollState.status, 'held'),
				),
			)
		return released
	})
}

export async function appendCourseSyncPollLog(input: CourseSyncPollLogInput) {
	await db.insert(courseSyncPollLog).values({
		id: `cspl_${randomUUID()}`,
		...input,
		metadata: input.metadata ?? null,
		failureClass: input.failureClass ?? null,
		controlPlaneRunId: input.controlPlaneRunId ?? null,
	})
	const event = `course_sync.poll.${input.stage}.${input.outcome}`
	const attributes = {
		bindingId: input.bindingId,
		courseVersionId: input.courseVersionId,
		providerRevision: input.providerRevision,
		runId: input.runId,
		controlPlaneRunId: input.controlPlaneRunId ?? null,
		failureClass: input.failureClass ?? null,
		...input.metadata,
	}
	if (input.outcome === 'failed' || input.outcome === 'held') {
		await log.error(event, attributes)
	} else {
		await log.info(event, attributes)
	}
}
