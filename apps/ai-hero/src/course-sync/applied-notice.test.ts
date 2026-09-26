import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syntheticCohortBinding } from './test-fixtures/cohort-binding'

const mocks = vi.hoisted(() => ({
	claim: vi.fn(async () => true),
	complete: vi.fn(async () => {}),
	fail: vi.fn(async () => {}),
	planChanges: vi.fn(async () => [
		{
			action: 'create' as const,
			sourceKind: 'lesson' as const,
			title: 'More Exercises',
			moved: false,
			detached: false,
		},
	]),
	narrate: vi.fn(async (): Promise<string | null> => 'Matt added a lesson.'),
	sendNotification: vi.fn(
		async (_options: {
			channel: string
			text: string
		}): Promise<{ ok: boolean; error?: string }> => ({ ok: true }),
	),
	logError: vi.fn(async () => {}),
	persisted: { bindingId: 'csb_ai_coding_crash_course' as string | null },
	select: vi.fn(),
	entitlementSync: vi.fn(
		async (): Promise<{ triggered: boolean; reason?: string }> => ({
			triggered: true,
		}),
	),
}))

vi.mock('@/db', () => ({ db: { select: mocks.select } }))
vi.mock('@/server/logger', () => ({
	log: { error: mocks.logError, info: vi.fn() },
}))
vi.mock('@/coursebuilder/slack-provider', () => ({
	slackProvider: {
		sendNotification: mocks.sendNotification,
		defaultChannelId: 'C_DEFAULT',
	},
}))
vi.mock('./cohort-entitlements', () => ({
	deliverCourseSyncEntitlementSync: mocks.entitlementSync,
}))
vi.mock('./types', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./types')>()
	return {
		...actual,
		COURSE_SYNC_BINDINGS: {
			...actual.COURSE_SYNC_BINDINGS,
			[syntheticCohortBinding.bindingId]: syntheticCohortBinding,
		},
		getServerCourseSyncBinding: (id: string) =>
			id === syntheticCohortBinding.bindingId
				? syntheticCohortBinding
				: actual.getServerCourseSyncBinding(id),
	}
})
vi.mock('./detection-persistence', () => ({
	claimCourseSyncReviewNotification: mocks.claim,
	completeCourseSyncReviewNotification: mocks.complete,
	failCourseSyncReviewNotification: mocks.fail,
	getCourseSyncPlanChanges: mocks.planChanges,
}))
vi.mock('./narrate', () => ({
	COURSE_SYNC_AUTHOR_NAME: 'Matt',
	narrateCourseSyncApply: mocks.narrate,
}))

import {
	deliverCourseSyncAppliedNotice,
	type CourseSyncAppliedNotification,
} from './applied-notice'

const notification: CourseSyncAppliedNotification = {
	kind: 'success',
	courseVersionId: 'version-1',
	courseName: 'AI Coding Crash Course',
	providerRevision: 'dropbox-rev-1',
	manifestSha256: 'manifest-sha',
	runId: 'poll-run-1',
	controlPlaneRunId: 'csr_run_1',
	resourceCounts: { create: 2, update: 3, retain: 230 },
	structureCounts: { sections: 6, lessons: 60, videos: 71 },
	durationSeconds: 120,
	mediaCount: 2,
	workshopEditUrl: 'https://www.aihero.dev/workshops/x/edit',
}

function deliver() {
	return deliverCourseSyncAppliedNotice({
		controlPlaneRunId: notification.controlPlaneRunId,
		pollRunId: notification.runId,
		notification,
		planSha256: 'plan-sha',
		clock: () => new Date('2026-08-26T00:00:00.000Z'),
	})
}

describe('course sync applied notice', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.claim.mockResolvedValue(true)
		mocks.sendNotification.mockResolvedValue({ ok: true })
		mocks.narrate.mockResolvedValue('Matt added a lesson.')
		mocks.persisted.bindingId = 'csb_ai_coding_crash_course'
		mocks.select.mockImplementation(() => ({
			from: () => ({
				where: () => ({
					limit: async () =>
						mocks.persisted.bindingId
							? [{ bindingId: mocks.persisted.bindingId }]
							: [],
				}),
			}),
		}))
	})

	it('dispatches cohort entitlement sync beside the applied notice for an operator or poller', async () => {
		mocks.persisted.bindingId = syntheticCohortBinding.bindingId
		await deliverCourseSyncAppliedNotice({
			controlPlaneRunId: notification.controlPlaneRunId,
			pollRunId: notification.runId,
			notification,
			planSha256: 'plan-sha',
		})
		expect(mocks.entitlementSync).toHaveBeenCalledWith({
			controlPlaneRunId: 'csr_run_1',
			lifecycle: 'applied',
		})
		expect(mocks.claim).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'applied' }),
		)
	})

	it('redelivery retries the v5 entitlement trigger even when the applied Slack receipt was already claimed', async () => {
		mocks.persisted.bindingId = syntheticCohortBinding.bindingId
		mocks.claim.mockResolvedValueOnce(false)
		await expect(
			deliverCourseSyncAppliedNotice({
				controlPlaneRunId: notification.controlPlaneRunId,
				pollRunId: notification.runId,
				notification,
				planSha256: 'plan-sha',
			}),
		).resolves.toEqual({ delivered: false, reason: 'already-claimed' })
		expect(mocks.entitlementSync).toHaveBeenCalledWith({
			controlPlaneRunId: 'csr_run_1',
			lifecycle: 'applied',
		})
		expect(mocks.sendNotification).not.toHaveBeenCalled()
	})

	it('still delivers the applied notice when the cohort trigger records a failure', async () => {
		mocks.persisted.bindingId = syntheticCohortBinding.bindingId
		mocks.entitlementSync.mockResolvedValueOnce({
			triggered: false,
			reason: 'failed',
		})
		await expect(
			deliverCourseSyncAppliedNotice({
				controlPlaneRunId: notification.controlPlaneRunId,
				pollRunId: notification.runId,
				notification,
				planSha256: 'plan-sha',
			}),
		).resolves.toEqual({ delivered: true })
		expect(mocks.complete).toHaveBeenCalledOnce()
	})

	it('operator v5 applies trigger entitlements from the persisted run without a caller binding', async () => {
		mocks.persisted.bindingId = syntheticCohortBinding.bindingId
		await deliver()
		expect(mocks.entitlementSync).toHaveBeenCalledWith({
			controlPlaneRunId: 'csr_run_1',
			lifecycle: 'applied',
		})
		expect(mocks.claim).toHaveBeenCalledWith(
			expect.objectContaining({ bindingId: syntheticCohortBinding.bindingId }),
		)
	})

	it('a missing persisted run throws instead of attributing the notice to Crash Course', async () => {
		mocks.persisted.bindingId = null
		await expect(deliver()).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
		expect(mocks.entitlementSync).not.toHaveBeenCalled()
		expect(mocks.claim).not.toHaveBeenCalled()
	})

	it('rejects a supplied notification for a different run before claiming or syncing', async () => {
		mocks.persisted.bindingId = syntheticCohortBinding.bindingId
		await expect(
			deliverCourseSyncAppliedNotice({
				controlPlaneRunId: notification.controlPlaneRunId,
				pollRunId: notification.runId,
				notification: { ...notification, controlPlaneRunId: 'other-run' },
				planSha256: 'plan-sha',
			}),
		).rejects.toMatchObject({ code: 'RUN_ID_MISMATCH' })
		expect(mocks.claim).not.toHaveBeenCalled()
		expect(mocks.entitlementSync).not.toHaveBeenCalled()
	})

	it('never dispatches cohort entitlements for a v4 applied notice', async () => {
		await deliverCourseSyncAppliedNotice({
			controlPlaneRunId: notification.controlPlaneRunId,
			pollRunId: notification.runId,
			notification,
			planSha256: 'plan-sha',
		})
		expect(mocks.entitlementSync).not.toHaveBeenCalled()
		expect(mocks.claim).toHaveBeenCalledWith(
			expect.objectContaining({ bindingId: 'csb_ai_coding_crash_course' }),
		)
	})

	it('claims under the applied kind so it cannot collide with a review notice', async () => {
		await deliver()

		expect(mocks.claim).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'applied',
				bindingId: 'csb_ai_coding_crash_course',
				controlPlaneRunId: 'csr_run_1',
				planSha256: 'plan-sha',
			}),
		)
	})

	it('posts the narrated summary and completes the claim', async () => {
		const result = await deliver()

		expect(result).toEqual({ delivered: true })
		const payload = mocks.sendNotification.mock.calls[0]?.[0]
		expect(payload?.channel).toBe('C_DEFAULT')
		expect(payload?.text).toContain('Matt added a lesson.')
		expect(mocks.complete).toHaveBeenCalledTimes(1)
	})

	it('does not post twice when the claim is already held', async () => {
		mocks.claim.mockResolvedValue(false)

		const result = await deliver()

		expect(result).toEqual({ delivered: false, reason: 'already-claimed' })
		expect(mocks.sendNotification).not.toHaveBeenCalled()
		expect(mocks.complete).not.toHaveBeenCalled()
	})

	it('falls back to the deterministic line when narration returns nothing', async () => {
		mocks.narrate.mockResolvedValue(null)

		await deliver()

		const payload = mocks.sendNotification.mock.calls[0]?.[0]
		expect(payload?.text).toContain('6 sections, 60 lessons, 71 videos')
	})

	it('still posts when the plan read for the summary fails', async () => {
		mocks.planChanges.mockRejectedValue(new Error('db blip'))

		const result = await deliver()

		expect(result).toEqual({ delivered: true })
		expect(mocks.narrate).toHaveBeenCalledWith(
			expect.objectContaining({ changes: [] }),
		)
	})

	it('fails the claim when Slack rejects the notice', async () => {
		mocks.sendNotification.mockResolvedValue({
			ok: false,
			error: 'channel_not_found',
		})

		await expect(deliver()).rejects.toThrow(/channel_not_found/)
		expect(mocks.fail).toHaveBeenCalledWith(
			expect.objectContaining({
				failureClass: 'APPLIED_NOTICE_DELIVERY_FAILED',
			}),
		)
		expect(mocks.complete).not.toHaveBeenCalled()
	})
})
