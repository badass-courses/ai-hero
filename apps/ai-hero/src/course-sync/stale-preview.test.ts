import { describe, expect, it, vi } from 'vitest'
import { remindStaleCourseSyncPreview } from './stale-preview'
import type { CourseSyncPollState } from './detection-poller'
import type { CourseSyncRunSummary } from '@ai-hero/course-sync-schema'

const input = {
	bindingId: 'binding-test',
	courseVersionId: 'version-test',
	controlPlaneRunId: 'run-test',
	planSha256: 'plan-test',
	heldAt: '2026-11-09T00:00:00.000Z',
}
function harness() {
	let now = new Date(input.heldAt)
	let claimed = false
	let state: CourseSyncPollState = {
		bindingId: input.bindingId,
		courseVersionId: input.courseVersionId,
		providerRevision: 'revision-test',
		status: 'awaiting-apply',
		consecutiveFailures: 0,
		controlPlaneRunId: input.controlPlaneRunId,
		failureClass: null,
		applyPolicyOverride: 'operator',
		updatedAt: now,
	}
	let run: CourseSyncRunSummary = {
		runId: input.controlPlaneRunId,
		bindingId: input.bindingId,
		courseVersionId: input.courseVersionId,
		state: 'previewed',
		planSha256: input.planSha256,
		noOp: false,
		failureCode: null,
		plan: { resources: [], media: [] },
		resourceCounts: { create: 0, update: 1, retain: 0 },
	}
	const notify = vi.fn(async () => {})
	const appendLog = vi.fn(async () => {})
	const dependencies = {
		getPollState: async () => state,
		getRun: async () => run,
		evaluateBoundedAutoApply: async () => ({
			eligible: false as const,
			planSha256: input.planSha256,
			failureCode: 'PROGRESSED_LESSON_CHANGE_REVIEW_REQUIRED',
			reason: 'Moving a lesson with progress requires review.',
			affectedLessons: [{ title: 'Protected lesson', progressCount: 3 }],
		}),
		claimReviewNotification: vi.fn(async () => {
			if (claimed) return false
			claimed = true
			return true
		}),
		completeReviewNotification: vi.fn(async () => {}),
		failReviewNotification: vi.fn(async () => {
			claimed = false
		}),
		notify,
		appendLog,
		clock: () => now,
	}
	return {
		dependencies,
		notify,
		appendLog,
		at: (minutes: number) => {
			now = new Date(new Date(input.heldAt).getTime() + minutes * 60_000)
		},
		state: (value: Partial<CourseSyncPollState>) => {
			state = { ...state, ...value }
		},
		run: (value: Partial<CourseSyncRunSummary>) => {
			run = { ...run, ...value }
		},
	}
}

describe('scheduled stale preview reminder', () => {
	it('does not need a manifest poll: none at 14, once at 15, none again at 30', async () => {
		const test = harness()
		test.at(14)
		expect(
			await remindStaleCourseSyncPreview(input, test.dependencies),
		).toMatchObject({ reminded: false })
		test.at(15)
		expect(
			await remindStaleCourseSyncPreview(input, test.dependencies),
		).toEqual({ reminded: true })
		expect(test.notify).toHaveBeenCalledWith(
			expect.objectContaining({
				minutesWaiting: 15,
				reasonCode: 'PROGRESSED_LESSON_CHANGE_REVIEW_REQUIRED',
				affectedLessons: [{ title: 'Protected lesson', progressCount: 3 }],
			}),
		)
		test.at(30)
		expect(
			await remindStaleCourseSyncPreview(input, test.dependencies),
		).toMatchObject({ reminded: false, reason: 'already-claimed' })
		expect(test.notify).toHaveBeenCalledOnce()
		expect(test.appendLog).toHaveBeenCalledOnce()
	})
	it.each(['succeeded', 'applying', 'released', 'held'] as const)(
		'skips when the poll state is %s by the deadline',
		async (status) => {
			const test = harness()
			test.at(15)
			test.state({ status })
			expect(
				await remindStaleCourseSyncPreview(input, test.dependencies),
			).toMatchObject({ reminded: false })
			expect(test.notify).not.toHaveBeenCalled()
		},
	)
	it('skips if operator apply committed before the poll state caught up', async () => {
		const test = harness()
		test.at(15)
		test.run({ state: 'applied' })
		expect(
			await remindStaleCourseSyncPreview(input, test.dependencies),
		).toMatchObject({ reminded: false })
		expect(test.notify).not.toHaveBeenCalled()
	})
	it('skips a changed run or plan', async () => {
		const test = harness()
		test.at(15)
		test.state({ controlPlaneRunId: 'new-run' })
		expect(
			await remindStaleCourseSyncPreview(input, test.dependencies),
		).toMatchObject({ reminded: false })
		test.state({ controlPlaneRunId: input.controlPlaneRunId })
		test.run({ planSha256: 'new-plan' })
		expect(
			await remindStaleCourseSyncPreview(input, test.dependencies),
		).toMatchObject({ reminded: false })
		expect(test.notify).not.toHaveBeenCalled()
	})
})
