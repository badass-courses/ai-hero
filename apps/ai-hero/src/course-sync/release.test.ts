import { describe, expect, it, vi } from 'vitest'

import {
	releaseCourseSyncPollHold,
	releasedCourseSyncPollState,
	type CourseSyncPollReleaseInput,
} from './release'
import { CourseSyncError } from './errors'
import type {
	CourseSyncPollLogInput,
	CourseSyncPollState,
} from './detection-poller'

const heldState: CourseSyncPollState = {
	bindingId: 'csb_ai_coding_crash_course',
	courseVersionId: 'version-2',
	providerRevision: 'dropbox-rev-2',
	status: 'held',
	consecutiveFailures: 1,
	controlPlaneRunId: null,
	failureClass: 'TARGET_CONTRACT_MISMATCH',
	applyPolicyOverride: null,
	updatedAt: new Date('2026-08-16T19:31:05.000Z'),
}

function harness(
	options: {
		assertTarget?: () => Promise<void>
		failAudit?: boolean
	} = {},
) {
	let state = structuredClone(heldState)
	const logs: CourseSyncPollLogInput[] = []
	const receipts = new Map<
		string,
		{ request: string; state: CourseSyncPollState }
	>()
	let transaction = Promise.resolve()
	const releaseAtomically = vi.fn(async (input: CourseSyncPollReleaseInput) => {
		let result!: CourseSyncPollState
		let failure: unknown
		transaction = transaction.then(async () => {
			try {
				const request = JSON.stringify({
					bindingId: input.bindingId,
					actor: input.actor,
					reason: input.reason,
				})
				const prior = receipts.get(input.operationId)
				if (prior) {
					if (prior.request !== request) {
						throw new CourseSyncError(
							'IDEMPOTENCY_CONFLICT',
							'Release key reused with different input.',
							409,
						)
					}
					result = structuredClone(prior.state)
					return
				}
				const transactionState = structuredClone(state)
				const transactionLogs = structuredClone(logs)
				await options.assertTarget?.()
				const released = releasedCourseSyncPollState(
					transactionState,
					input.occurredAt,
				)
				transactionLogs.push({
					bindingId: input.bindingId,
					courseVersionId: state.courseVersionId,
					providerRevision: state.providerRevision,
					runId: input.operationId,
					stage: 'release',
					outcome: 'succeeded',
					occurredAt: input.occurredAt,
				})
				if (options.failAudit) throw new Error('audit insert failed')
				state = released
				logs.splice(0, logs.length, ...transactionLogs)
				receipts.set(input.operationId, { request, state: released })
				result = structuredClone(released)
			} catch (error) {
				failure = error
			}
		})
		await transaction
		if (failure) throw failure
		return result
	})
	const release = (input: Partial<CourseSyncPollReleaseInput> = {}) =>
		releaseCourseSyncPollHold(
			{ releaseAtomically },
			{
				bindingId: heldState.bindingId,
				actor: 'operator',
				reason: 'Target contract corrected and reviewed.',
				operationId: 'release-1',
				occurredAt: new Date('2026-08-16T20:00:00.000Z'),
				...input,
			},
		)
	return { release, releaseAtomically, logs, state: () => state }
}

describe('operator course sync hold release', () => {
	it('delegates one normalized atomic release operation', async () => {
		const assertTarget = vi.fn(async () => undefined)
		const test = harness({ assertTarget })

		await expect(
			test.release({ reason: '  Target   corrected.  ' }),
		).resolves.toMatchObject({ status: 'released' })
		expect(assertTarget).toHaveBeenCalledOnce()
		expect(test.releaseAtomically).toHaveBeenCalledWith(
			expect.objectContaining({ reason: 'Target corrected.' }),
		)
		expect(test.state()).toMatchObject({
			status: 'released',
			consecutiveFailures: 0,
			failureClass: null,
			controlPlaneRunId: null,
			applyPolicyOverride: 'operator',
		})
		expect(test.logs).toHaveLength(1)
	})

	it('rolls back state when target recheck or audit insertion fails', async () => {
		const targetFailure = harness({
			assertTarget: async () => {
				throw new CourseSyncError(
					'TARGET_CONTRACT_MISMATCH',
					'Target contract mismatch.',
					409,
				)
			},
		})
		await expect(targetFailure.release()).rejects.toMatchObject({
			code: 'TARGET_CONTRACT_MISMATCH',
		})
		expect(targetFailure.state()).toEqual(heldState)
		expect(targetFailure.logs).toHaveLength(0)

		const auditFailure = harness({ failAudit: true })
		await expect(auditFailure.release()).rejects.toThrow('audit insert failed')
		expect(auditFailure.state()).toEqual(heldState)
		expect(auditFailure.logs).toHaveLength(0)
	})

	it('replays one receipt and rejects conflicting key reuse', async () => {
		const test = harness()
		const first = await test.release()
		const replay = await test.release()
		expect(replay).toEqual(first)
		expect(test.logs).toHaveLength(1)

		await expect(
			test.release({ reason: 'Different operator decision.' }),
		).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
		expect(test.logs).toHaveLength(1)
	})

	it('serializes concurrent retries into one receipt', async () => {
		const test = harness()
		const [first, second] = await Promise.all([test.release(), test.release()])
		expect(second).toEqual(first)
		expect(test.logs).toHaveLength(1)
	})

	it('rejects unbounded operation IDs before persistence', async () => {
		const test = harness()
		await expect(
			test.release({ operationId: 'x'.repeat(256) }),
		).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' })
		expect(test.releaseAtomically).not.toHaveBeenCalled()
	})
})
