import { describe, expect, it, vi } from 'vitest'

import { CourseSyncError } from './errors'
import { releaseCourseSyncPollHold } from './release'
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
	updatedAt: new Date('2026-08-16T19:31:05.000Z'),
}

function harness(
	assertTarget: (bindingId: string) => Promise<void> = vi.fn(
		async () => undefined,
	),
) {
	let state = structuredClone(heldState)
	const logs: CourseSyncPollLogInput[] = []
	return {
		assertTarget,
		logs,
		state: () => state,
		release: (reason = 'Target contract corrected and reviewed.') =>
			releaseCourseSyncPollHold(
				{
					assertTarget,
					getPollState: async () => state,
					savePollState: async (next) => {
						state = next
					},
					appendLog: async (entry) => {
						logs.push(entry)
					},
				},
				{
					bindingId: heldState.bindingId,
					actor: 'operator',
					reason,
					operationId: 'release-1',
					occurredAt: new Date('2026-08-16T20:00:00.000Z'),
				},
			),
	}
}

describe('operator course sync hold release', () => {
	it('rechecks the target, resets held state, and writes an audit log', async () => {
		const test = harness()
		await expect(test.release()).resolves.toMatchObject({ status: 'released' })
		expect(test.assertTarget).toHaveBeenCalledOnce()
		expect(test.state()).toMatchObject({
			status: 'released',
			consecutiveFailures: 0,
			failureClass: null,
			controlPlaneRunId: null,
		})
		expect(test.logs).toEqual([
			expect.objectContaining({
				stage: 'release',
				outcome: 'succeeded',
				metadata: expect.objectContaining({
					actor: 'operator',
					reason: 'Target contract corrected and reviewed.',
					previousStatus: 'held',
				}),
			}),
		])
	})

	it('leaves the hold untouched when the target still fails', async () => {
		const test = harness(
			vi.fn(async () => {
				throw new CourseSyncError(
					'TARGET_CONTRACT_MISMATCH',
					'Target contract mismatch.',
					409,
				)
			}),
		)
		await expect(test.release()).rejects.toMatchObject({
			code: 'TARGET_CONTRACT_MISMATCH',
		})
		expect(test.state()).toEqual(heldState)
		expect(test.logs).toHaveLength(0)
	})
})
