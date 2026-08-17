import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'

import { courseSyncPollMachine } from './poll-machine'
import type { CourseSyncBinding } from './types'

function actor(
	status: string | null,
	strikes = 0,
	applyPolicy: CourseSyncBinding['applyPolicy'] = 'operator',
) {
	return createActor(courseSyncPollMachine, {
		input: { pollStatus: status, strikes, applyPolicy },
	}).start()
}

describe('course sync poll machine', () => {
	it('routes only eligible bounded-auto previews to applying', () => {
		const eligible = actor(null, 0, 'bounded-auto')
		eligible.send({ type: 'REVISION.START' })
		eligible.send({
			type: 'PREVIEW.EVALUATED',
			boundedAutoEligible: true,
		})
		expect(eligible.getSnapshot().value).toEqual({ active: 'applying' })

		const ineligible = actor(null, 0, 'bounded-auto')
		ineligible.send({ type: 'REVISION.START' })
		ineligible.send({
			type: 'PREVIEW.EVALUATED',
			boundedAutoEligible: false,
		})
		expect(ineligible.getSnapshot().value).toEqual({
			active: 'awaitingApply',
		})
	})

	it('stops operator-policy previews at awaiting apply', () => {
		const poll = actor(null)
		poll.send({ type: 'REVISION.START' })
		poll.send({
			type: 'PREVIEW.EVALUATED',
			boundedAutoEligible: true,
		})
		expect(poll.getSnapshot().value).toEqual({ active: 'awaitingApply' })
	})

	it('tracks every external apply outcome', () => {
		const applying = actor('awaiting-apply')
		applying.send({ type: 'APPLY.START' })
		expect(applying.getSnapshot().value).toEqual({ active: 'applying' })

		const applied = actor('applying')
		applied.send({ type: 'APPLY.OK' })
		expect(applied.getSnapshot().value).toEqual({ active: 'idle' })

		const failed = actor('awaiting-apply')
		failed.send({ type: 'APPLY.FAILED' })
		expect(failed.getSnapshot().value).toEqual({ active: 'held' })

		const rolledBack = actor('awaiting-apply')
		rolledBack.send({ type: 'APPLY.ROLLED_BACK' })
		expect(rolledBack.getSnapshot().value).toEqual({ active: 'held' })

		const superseded = actor('awaiting-apply')
		superseded.send({ type: 'APPLY.SUPERSEDED' })
		expect(superseded.getSnapshot().value).toEqual({ active: 'held' })
	})

	it('holds deterministic failures immediately and transient failures on strike two', () => {
		const deterministic = actor(null)
		deterministic.send({ type: 'REVISION.START' })
		deterministic.send({ type: 'FAIL.NON_RETRYABLE' })
		expect(deterministic.getSnapshot().value).toEqual({ active: 'held' })
		expect(deterministic.getSnapshot().context.strikes).toBe(1)

		const first = actor(null)
		first.send({ type: 'REVISION.START' })
		first.send({ type: 'FAIL.RETRYABLE' })
		expect(first.getSnapshot().value).toEqual({ active: 'failed' })
		expect(first.getSnapshot().context.strikes).toBe(1)

		const second = actor('failed', 1)
		second.send({ type: 'REVISION.START' })
		second.send({ type: 'FAIL.RETRYABLE' })
		expect(second.getSnapshot().value).toEqual({ active: 'held' })
		expect(second.getSnapshot().context.strikes).toBe(2)
	})

	it('requires operator release to leave held', () => {
		const held = actor('held', 1)
		held.send({ type: 'OPERATOR.RELEASE' })
		expect(held.getSnapshot().value).toEqual({ active: 'idle' })
		expect(held.getSnapshot().context.strikes).toBe(0)
	})

	it('declares only events used by poll or release code', () => {
		expect(new Set(courseSyncPollMachine.events)).toEqual(
			new Set([
				'REVISION.START',
				'PREVIEW.EVALUATED',
				'APPLY.START',
				'APPLY.OK',
				'APPLY.FAILED',
				'APPLY.ROLLED_BACK',
				'APPLY.SUPERSEDED',
				'FAIL.RETRYABLE',
				'FAIL.NON_RETRYABLE',
				'OPERATOR.RELEASE',
			]),
		)
	})
})
