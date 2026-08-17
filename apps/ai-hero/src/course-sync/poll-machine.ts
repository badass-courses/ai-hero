import { assign, createActor, setup } from 'xstate'

import type { CourseSyncBinding } from './types'

export type CourseSyncPollMachineInput = {
	pollStatus: string | null
	strikes: number
	applyPolicy: CourseSyncBinding['applyPolicy']
}

export type CourseSyncPollMachineEvent =
	| { type: 'REVISION.START' }
	| { type: 'PREVIEW.EVALUATED'; boundedAutoEligible: boolean }
	| { type: 'APPLY.START' }
	| { type: 'APPLY.OK' }
	| { type: 'APPLY.FAILED' }
	| { type: 'APPLY.ROLLED_BACK' }
	| { type: 'APPLY.SUPERSEDED' }
	| { type: 'FAIL.RETRYABLE' }
	| { type: 'FAIL.NON_RETRYABLE' }
	| { type: 'OPERATOR.RELEASE' }

export const courseSyncPollMachine = setup({
	types: {
		context: {} as CourseSyncPollMachineInput,
		input: {} as CourseSyncPollMachineInput,
		events: {} as CourseSyncPollMachineEvent,
	},
	guards: {
		wasHeld: ({ context }) => context.pollStatus === 'held',
		wasAwaitingApply: ({ context }) => context.pollStatus === 'awaiting-apply',
		wasApplying: ({ context }) => context.pollStatus === 'applying',
		wasFailed: ({ context }) => context.pollStatus === 'failed',
		wasStaging: ({ context }) => context.pollStatus === 'staging',
		boundedAutoApply: ({ context, event }) =>
			context.applyPolicy === 'bounded-auto' &&
			event.type === 'PREVIEW.EVALUATED' &&
			event.boundedAutoEligible,
		hasTransientStrike: ({ context }) => context.strikes >= 1,
	},
	actions: {
		incrementStrike: assign({
			strikes: ({ context }) => Math.min(context.strikes + 1, 2),
		}),
		resetStrikes: assign({ strikes: 0 }),
	},
}).createMachine({
	id: 'courseSyncPoll',
	context: ({ input }) => input,
	initial: 'restoring',
	states: {
		restoring: {
			always: [
				{ guard: 'wasHeld', target: '#courseSyncPoll.active.held' },
				{
					guard: 'wasAwaitingApply',
					target: '#courseSyncPoll.active.awaitingApply',
				},
				{ guard: 'wasApplying', target: '#courseSyncPoll.active.applying' },
				{ guard: 'wasFailed', target: '#courseSyncPoll.active.failed' },
				{ guard: 'wasStaging', target: '#courseSyncPoll.active.staging' },
				{ target: '#courseSyncPoll.active.idle' },
			],
		},
		active: {
			initial: 'idle',
			states: {
				idle: {
					on: { 'REVISION.START': 'staging' },
				},
				staging: {
					on: {
						'PREVIEW.EVALUATED': [
							{ guard: 'boundedAutoApply', target: 'applying' },
							{ target: 'awaitingApply' },
						],
						'FAIL.NON_RETRYABLE': {
							target: 'held',
							actions: 'incrementStrike',
						},
						'FAIL.RETRYABLE': [
							{
								guard: 'hasTransientStrike',
								target: 'held',
								actions: 'incrementStrike',
							},
							{ target: 'failed', actions: 'incrementStrike' },
						],
					},
				},
				awaitingApply: {
					on: {
						'APPLY.START': 'applying',
						'APPLY.OK': { target: 'idle', actions: 'resetStrikes' },
						'APPLY.FAILED': {
							target: 'held',
							actions: 'incrementStrike',
						},
						'APPLY.ROLLED_BACK': {
							target: 'held',
							actions: 'incrementStrike',
						},
						'APPLY.SUPERSEDED': {
							target: 'held',
							actions: 'incrementStrike',
						},
					},
				},
				applying: {
					on: {
						'APPLY.OK': { target: 'idle', actions: 'resetStrikes' },
						'APPLY.FAILED': {
							target: 'held',
							actions: 'incrementStrike',
						},
						'APPLY.ROLLED_BACK': {
							target: 'held',
							actions: 'incrementStrike',
						},
						'APPLY.SUPERSEDED': {
							target: 'held',
							actions: 'incrementStrike',
						},
						'FAIL.NON_RETRYABLE': {
							target: 'held',
							actions: 'incrementStrike',
						},
						'FAIL.RETRYABLE': [
							{
								guard: 'hasTransientStrike',
								target: 'held',
								actions: 'incrementStrike',
							},
							{ target: 'failed', actions: 'incrementStrike' },
						],
					},
				},
				failed: {
					on: { 'REVISION.START': 'staging' },
				},
				held: {
					on: {
						'OPERATOR.RELEASE': {
							target: 'idle',
							actions: 'resetStrikes',
						},
					},
				},
			},
		},
	},
})

export function startCourseSyncPollLifecycle(
	input: CourseSyncPollMachineInput,
) {
	return createActor(courseSyncPollMachine, { input }).start()
}

export type CourseSyncPollLifecycleActor = ReturnType<
	typeof startCourseSyncPollLifecycle
>
