import { setup } from 'xstate'

export type CourseSyncRunEvent =
	| { type: 'PREVIEW' }
	| { type: 'APPLY' }
	| { type: 'APPLIED' }
	| { type: 'FAIL' }
	| { type: 'RETRY' }
	| { type: 'ROLLBACK' }

/**
 * The lifecycle is deliberately finite. There is no publish transition.
 * A failed apply retries only after the persistence layer proves that the
 * prior atomic transaction rolled back and the same plan/key still own it.
 */
export const courseSyncRunMachine = setup({
	types: {
		events: {} as CourseSyncRunEvent,
	},
}).createMachine({
	id: 'courseSyncRun',
	initial: 'staged',
	states: {
		staged: { on: { PREVIEW: 'previewed' } },
		previewed: { on: { APPLY: 'applying' } },
		applying: { on: { APPLIED: 'applied', FAIL: 'failed' } },
		applied: { on: { ROLLBACK: 'rolled_back' } },
		failed: { on: { RETRY: 'applying' } },
		rolled_back: { type: 'final' },
	},
})
