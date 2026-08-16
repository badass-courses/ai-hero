import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'

import { courseSyncPollMachine } from './poll-machine'

function actor(status: string | null, strikes = 0) {
	return createActor(courseSyncPollMachine, {
		input: {
			bindingStatus: 'active',
			pollStatus: status,
			strikes,
			applyPolicy: 'operator',
		},
	}).start()
}

describe('course sync binding and poll machine', () => {
	it('stops an operator-policy run at awaiting apply', () => {
		const poll = actor(null)
		poll.send({ type: 'REVISION.START' })
		poll.send({ type: 'PREVIEW.OK' })
		expect(poll.getSnapshot().value).toEqual({ active: 'awaitingApply' })
	})

	it('holds deterministic failures immediately without a retry strike', () => {
		const poll = actor(null)
		poll.send({ type: 'REVISION.START' })
		poll.send({ type: 'FAIL.NON_RETRYABLE' })
		expect(poll.getSnapshot().value).toEqual({ active: 'held' })
		expect(poll.getSnapshot().context.strikes).toBe(1)
	})

	it('retries one transient failure and holds the second', () => {
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

	it('requires operator release to leave held and makes revoked final', () => {
		const held = actor('held', 1)
		held.send({ type: 'TICK' })
		expect(held.getSnapshot().value).toEqual({ active: 'held' })
		held.send({ type: 'OPERATOR.RELEASE' })
		expect(held.getSnapshot().value).toEqual({ active: 'idle' })

		const revoked = createActor(courseSyncPollMachine, {
			input: {
				bindingStatus: 'revoked',
				pollStatus: null,
				strikes: 0,
				applyPolicy: 'operator',
			},
		}).start()
		expect(revoked.getSnapshot().status).toBe('done')
	})
})
