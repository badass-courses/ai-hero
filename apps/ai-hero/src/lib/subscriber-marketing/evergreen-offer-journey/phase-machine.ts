import {
	initialTransition,
	setup,
	transition,
	type SnapshotFrom,
} from 'xstate'

import type { JourneyPhase } from './domain'

export type JourneyPhaseEvent =
	| { readonly type: 'START' }
	| { readonly type: 'BRIDGE_SLOTS_FINISHED' }
	| { readonly type: 'COUPON_WAKE' }
	| { readonly type: 'COUPON_ISSUED' }
	| { readonly type: 'COUPON_EXPIRED' }
	| { readonly type: 'SHADOW_ENTERED' }
	| { readonly type: 'PURCHASE' }
	| { readonly type: 'STOP' }

const phaseState = {
	'bridge.running': 'bridgeRunning',
	'coupon.waiting': 'couponWaiting',
	'coupon.awaitingReceipt': 'couponAwaitingReceipt',
	'pitch.running': 'pitchRunning',
	'handoff.awaitingReceipt': 'handoffAwaitingReceipt',
	customer: 'customer',
	stopped: 'stopped',
	complete: 'complete',
} as const satisfies Record<JourneyPhase, string>

const statePhase = {
	bridgeRunning: 'bridge.running',
	couponWaiting: 'coupon.waiting',
	couponAwaitingReceipt: 'coupon.awaitingReceipt',
	pitchRunning: 'pitch.running',
	handoffAwaitingReceipt: 'handoff.awaitingReceipt',
	customer: 'customer',
	stopped: 'stopped',
	complete: 'complete',
} as const satisfies Record<string, JourneyPhase>

export const evergreenOfferPhaseMachine = setup({
	types: {
		// SAFETY: XState reads this value only as compile-time event metadata.
		events: {} as JourneyPhaseEvent,
	},
}).createMachine({
	id: 'evergreen-offer-journey',
	initial: 'notStarted',
	states: {
		notStarted: {
			on: { START: 'bridgeRunning' },
		},
		bridgeRunning: {
			on: {
				BRIDGE_SLOTS_FINISHED: 'couponWaiting',
				COUPON_WAKE: 'couponAwaitingReceipt',
				PURCHASE: 'customer',
				STOP: 'stopped',
			},
		},
		couponWaiting: {
			on: {
				COUPON_WAKE: 'couponAwaitingReceipt',
				PURCHASE: 'customer',
				STOP: 'stopped',
			},
		},
		couponAwaitingReceipt: {
			on: {
				COUPON_ISSUED: 'pitchRunning',
				PURCHASE: 'customer',
				STOP: 'stopped',
			},
		},
		pitchRunning: {
			on: {
				COUPON_EXPIRED: 'handoffAwaitingReceipt',
				PURCHASE: 'customer',
				STOP: 'stopped',
			},
		},
		handoffAwaitingReceipt: {
			on: {
				SHADOW_ENTERED: 'complete',
				PURCHASE: 'customer',
				STOP: 'stopped',
			},
		},
		customer: { type: 'final' },
		stopped: { type: 'final' },
		complete: { type: 'final' },
	},
})

export type PhaseTransitionResult =
	| { readonly ok: true; readonly phase: JourneyPhase }
	| {
			readonly ok: false
			readonly from: JourneyPhase | 'not_started'
			readonly event: JourneyPhaseEvent['type']
	  }

export function transitionJourneyPhase(args: {
	from: JourneyPhase | 'not_started'
	event: JourneyPhaseEvent
}): PhaseTransitionResult {
	const current =
		args.from === 'not_started'
			? initialTransition(evergreenOfferPhaseMachine)[0]
			: evergreenOfferPhaseMachine.resolveState({
					value: phaseState[args.from],
					context: {},
				})
	const [next] = transition(evergreenOfferPhaseMachine, current, args.event)
	if (next.value === current.value) {
		return { ok: false, from: args.from, event: args.event.type }
	}
	const phase = phaseFromSnapshot(next)
	return phase
		? { ok: true, phase }
		: { ok: false, from: args.from, event: args.event.type }
}

function phaseFromSnapshot(
	snapshot: SnapshotFrom<typeof evergreenOfferPhaseMachine>,
): JourneyPhase | null {
	if (snapshot.matches('bridgeRunning')) return statePhase.bridgeRunning
	if (snapshot.matches('couponWaiting')) return statePhase.couponWaiting
	if (snapshot.matches('couponAwaitingReceipt')) {
		return statePhase.couponAwaitingReceipt
	}
	if (snapshot.matches('pitchRunning')) return statePhase.pitchRunning
	if (snapshot.matches('handoffAwaitingReceipt')) {
		return statePhase.handoffAwaitingReceipt
	}
	if (snapshot.matches('customer')) return statePhase.customer
	if (snapshot.matches('stopped')) return statePhase.stopped
	if (snapshot.matches('complete')) return statePhase.complete
	return null
}
