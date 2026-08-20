import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	createGestureMachine,
	type GestureCallbacks,
	type GestureMachine,
} from './video-gesture-machine'

function setup() {
	const callbacks = {
		onSingleTap: vi.fn(),
		onSeek: vi.fn(),
		onHoldStart: vi.fn(),
		onHoldEnd: vi.fn(),
	} satisfies GestureCallbacks
	const machine = createGestureMachine(callbacks)
	return { callbacks, machine }
}

function tap(machine: GestureMachine, zone: 'left' | 'center' | 'right') {
	machine.pointerDown(zone, 100, 100)
	machine.pointerUp()
}

describe('createGestureMachine', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('fires onSingleTap after the disambiguation window on a single tap', () => {
		const { callbacks, machine } = setup()
		tap(machine, 'center')
		expect(callbacks.onSingleTap).not.toHaveBeenCalled()
		vi.advanceTimersByTime(250)
		expect(callbacks.onSingleTap).toHaveBeenCalledTimes(1)
		expect(callbacks.onSeek).not.toHaveBeenCalled()
	})

	it('seeks +10 on a right-zone double tap and never toggles chrome', () => {
		const { callbacks, machine } = setup()
		tap(machine, 'right')
		vi.advanceTimersByTime(100)
		tap(machine, 'right')
		expect(callbacks.onSeek).toHaveBeenCalledWith(10, 10, 'right')
		vi.advanceTimersByTime(1000)
		expect(callbacks.onSingleTap).not.toHaveBeenCalled()
	})

	it('seeks -10 on a left-zone double tap', () => {
		const { callbacks, machine } = setup()
		tap(machine, 'left')
		tap(machine, 'left')
		expect(callbacks.onSeek).toHaveBeenCalledWith(-10, 10, 'left')
	})

	it('accumulates further single taps on the same side within the window', () => {
		const { callbacks, machine } = setup()
		tap(machine, 'right')
		tap(machine, 'right')
		vi.advanceTimersByTime(300)
		tap(machine, 'right')
		vi.advanceTimersByTime(300)
		tap(machine, 'right')
		expect(callbacks.onSeek).toHaveBeenNthCalledWith(1, 10, 10, 'right')
		expect(callbacks.onSeek).toHaveBeenNthCalledWith(2, 10, 20, 'right')
		expect(callbacks.onSeek).toHaveBeenNthCalledWith(3, 10, 30, 'right')
		expect(callbacks.onSingleTap).not.toHaveBeenCalled()
	})

	it('a center tap during a burst ends it and acts as a fresh first tap', () => {
		const { callbacks, machine } = setup()
		tap(machine, 'right')
		tap(machine, 'right')
		tap(machine, 'center')
		expect(callbacks.onSeek).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(250)
		expect(callbacks.onSingleTap).toHaveBeenCalledTimes(1)
		// and the burst is over: a later side tap is a first tap again
		tap(machine, 'right')
		vi.advanceTimersByTime(250)
		expect(callbacks.onSeek).toHaveBeenCalledTimes(1)
		expect(callbacks.onSingleTap).toHaveBeenCalledTimes(2)
	})

	it('a tap on the opposite side during a burst starts a new burst there', () => {
		const { callbacks, machine } = setup()
		tap(machine, 'right')
		tap(machine, 'right')
		tap(machine, 'left')
		expect(callbacks.onSeek).toHaveBeenLastCalledWith(-10, 10, 'left')
	})

	it('the burst expires after the accumulate window', () => {
		const { callbacks, machine } = setup()
		tap(machine, 'right')
		tap(machine, 'right')
		vi.advanceTimersByTime(651)
		tap(machine, 'right')
		// Post-expiry the tap is a fresh first tap, so it pends a chrome toggle.
		expect(callbacks.onSeek).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(250)
		expect(callbacks.onSingleTap).toHaveBeenCalledTimes(1)
	})

	it('treats a center-zone double tap as a single chrome toggle', () => {
		const { callbacks, machine } = setup()
		tap(machine, 'center')
		tap(machine, 'center')
		expect(callbacks.onSingleTap).toHaveBeenCalledTimes(1)
		expect(callbacks.onSeek).not.toHaveBeenCalled()
	})

	it('starts and ends a hold without firing tap actions', () => {
		const { callbacks, machine } = setup()
		machine.pointerDown('center', 100, 100)
		vi.advanceTimersByTime(500)
		expect(callbacks.onHoldStart).toHaveBeenCalledTimes(1)
		machine.pointerUp()
		expect(callbacks.onHoldEnd).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(1000)
		expect(callbacks.onSingleTap).not.toHaveBeenCalled()
		expect(callbacks.onSeek).not.toHaveBeenCalled()
	})

	it('a hold supersedes a pending single tap', () => {
		const { callbacks, machine } = setup()
		tap(machine, 'center')
		machine.pointerDown('center', 100, 100)
		vi.advanceTimersByTime(500)
		expect(callbacks.onHoldStart).toHaveBeenCalledTimes(1)
		machine.pointerUp()
		vi.advanceTimersByTime(1000)
		expect(callbacks.onSingleTap).not.toHaveBeenCalled()
	})

	it('pointer travel cancels the tap and the hold', () => {
		const { callbacks, machine } = setup()
		machine.pointerDown('right', 100, 100)
		machine.pointerMove(130, 100)
		vi.advanceTimersByTime(600)
		expect(callbacks.onHoldStart).not.toHaveBeenCalled()
		machine.pointerUp()
		vi.advanceTimersByTime(1000)
		expect(callbacks.onSingleTap).not.toHaveBeenCalled()
		expect(callbacks.onSeek).not.toHaveBeenCalled()
	})

	it('small pointer jitter does not cancel the tap', () => {
		const { callbacks, machine } = setup()
		machine.pointerDown('center', 100, 100)
		machine.pointerMove(104, 103)
		machine.pointerUp()
		vi.advanceTimersByTime(250)
		expect(callbacks.onSingleTap).toHaveBeenCalledTimes(1)
	})

	it('cancel ends an active hold and clears pending taps', () => {
		const { callbacks, machine } = setup()
		machine.pointerDown('center', 100, 100)
		vi.advanceTimersByTime(500)
		machine.cancel()
		expect(callbacks.onHoldEnd).toHaveBeenCalledTimes(1)
		tap(machine, 'right')
		vi.advanceTimersByTime(250)
		// Fresh state after cancel: the tap is a first tap again.
		expect(callbacks.onSingleTap).toHaveBeenCalledTimes(1)
		expect(callbacks.onSeek).not.toHaveBeenCalled()
	})
})
