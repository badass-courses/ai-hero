import { setup } from 'xstate'

export type CourseSyncRunEvent =
	| { type: 'PREVIEW' }
	| { type: 'APPLY' }
	| { type: 'APPLIED' }
	| { type: 'FAIL' }
	| { type: 'ROLLBACK' }

/**
 * The lifecycle is deliberately finite. There is no publish transition and no
 * automatic retry transition for apply or rollback.
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
		failed: { type: 'final' },
		rolled_back: { type: 'final' },
	},
})
