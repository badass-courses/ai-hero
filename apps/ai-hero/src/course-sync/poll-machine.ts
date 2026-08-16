import { assign, createActor, setup } from 'xstate'

import type { CourseSyncBinding } from './types'

export type CourseSyncPollMachineInput = {
	bindingStatus: CourseSyncBinding['status']
	pollStatus: string | null
	strikes: number
	applyPolicy: CourseSyncBinding['applyPolicy']
}

export type CourseSyncPollMachineEvent =
	| { type: 'TICK' }
	| { type: 'REVISION.START' }
	| { type: 'REVISION.NEW' }
	| { type: 'PREVIEW.OK' }
	| { type: 'APPLY.OK' }
	| { type: 'FAIL.RETRYABLE' }
	| { type: 'FAIL.NON_RETRYABLE' }
	| { type: 'OPERATOR.RELEASE' }
	| { type: 'OPERATOR.SUSPEND' }
	| { type: 'OPERATOR.RESUME' }
	| { type: 'OPERATOR.REVOKE' }

export const courseSyncPollMachine = setup({
	types: {
		context: {} as CourseSyncPollMachineInput,
		input: {} as CourseSyncPollMachineInput,
		events: {} as CourseSyncPollMachineEvent,
	},
	guards: {
		bindingRevoked: ({ context }) => context.bindingStatus === 'revoked',
		bindingSuspended: ({ context }) => context.bindingStatus === 'suspended',
		wasHeld: ({ context }) => context.pollStatus === 'held',
		wasAwaitingApply: ({ context }) => context.pollStatus === 'awaiting-apply',
		wasFailed: ({ context }) => context.pollStatus === 'failed',
		wasStaging: ({ context }) => context.pollStatus === 'staging',
		operatorApply: ({ context }) => context.applyPolicy === 'operator',
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
				{ guard: 'bindingRevoked', target: 'revoked' },
				{ guard: 'bindingSuspended', target: 'suspended' },
				{ guard: 'wasHeld', target: '#courseSyncPoll.active.held' },
				{
					guard: 'wasAwaitingApply',
					target: '#courseSyncPoll.active.awaitingApply',
				},
				{ guard: 'wasFailed', target: '#courseSyncPoll.active.failed' },
				{ guard: 'wasStaging', target: '#courseSyncPoll.active.staging' },
				{ target: '#courseSyncPoll.active.idle' },
			],
		},
		active: {
			initial: 'idle',
			on: {
				'OPERATOR.SUSPEND': '#courseSyncPoll.suspended',
				'OPERATOR.REVOKE': '#courseSyncPoll.revoked',
			},
			states: {
				idle: {
					on: { 'REVISION.START': 'staging' },
				},
				staging: {
					on: {
						'PREVIEW.OK': [
							{ guard: 'operatorApply', target: 'awaitingApply' },
							{ target: 'applying' },
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
						'REVISION.NEW': 'staging',
						'APPLY.OK': { target: 'idle', actions: 'resetStrikes' },
					},
				},
				applying: {
					on: {
						'APPLY.OK': { target: 'idle', actions: 'resetStrikes' },
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
		suspended: {
			on: {
				'OPERATOR.RESUME': 'active',
				'OPERATOR.REVOKE': 'revoked',
			},
		},
		revoked: { type: 'final' },
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
