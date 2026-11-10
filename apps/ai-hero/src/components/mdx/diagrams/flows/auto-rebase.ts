import type { FlowDiagram } from '../flow'
import { left, right } from './lanes'

/**
 * Matt's Auto-Rebase, from The Morning Rebase's solution, as he finished it.
 * He built it up on camera, so `part-one.tsx` draws the earlier frames from
 * it with `stage`.
 */
export const autoRebase: FlowDiagram = {
	title: 'Auto-Rebase',
	description: 'Once a day, get all open PR’s rebased against their branches.',
	nodes: [
		{
			id: 'fetch',
			roles: ['git'],
			text: 'Fetch PR’s that are out of date with their bases',
			...left(1),
		},
		{
			id: 'midnight',
			roles: ['orchestrator'],
			text: 'Once per day, at midnight',
			...right(1),
		},
		{
			id: 'schedule',
			roles: ['orchestrator'],
			text: 'Orchestrator schedules one runner per unblocked PR',
			...left(2),
		},
		{
			id: 'label-added',
			roles: ['orchestrator'],
			text: 'Label added to a PR',
			...right(3),
		},
		{
			id: 'runner',
			roles: ['runner'],
			text: 'One runner per PR',
			...left(3),
		},
		{
			id: 'attempt',
			roles: ['runner'],
			text: 'Attempt to rebase via a script',
			...left(4),
		},
		{
			id: 'works',
			roles: ['runner'],
			text: 'If it works…',
			...right(4),
		},
		{
			id: 'conflicts',
			roles: ['runner'],
			text: 'If it conflicts, spin up an agent to fix the conflicts',
			...left(5),
		},
		{
			id: 'force-push',
			roles: ['git'],
			text: 'Force-push back to the git host',
			...right(5),
		},
		{
			id: 'unresolved',
			roles: ['runner'],
			text: 'If conflicts can’t be easily resolved, or the PR is superceded…',
			...left(6),
		},
		{
			id: 'issue',
			roles: ['tracker'],
			text: 'Add an issue to the ticket tracker to resolve it',
			...left(7),
		},
		{
			id: 'blocked',
			roles: ['git'],
			text: 'Label the PR as blocked',
			...right(7),
		},
	],
	edges: [
		{ from: 'fetch', to: 'schedule', exit: 'left', enter: 'left' },
		{ from: 'midnight', to: 'schedule', exit: 'bottom', enter: 'right' },
		{ from: 'schedule', to: 'runner', exit: 'left', enter: 'left' },
		{ from: 'label-added', to: 'runner', exit: 'left', enter: 'right' },
		{ from: 'runner', to: 'attempt', exit: 'left', enter: 'left' },
		{ from: 'attempt', to: 'works', exit: 'right', enter: 'left' },
		{ from: 'attempt', to: 'conflicts', exit: 'left', enter: 'left' },
		{ from: 'works', to: 'force-push', exit: 'left', enter: 'left' },
		{ from: 'conflicts', to: 'force-push', exit: 'right', enter: 'left' },
		{ from: 'conflicts', to: 'unresolved', exit: 'left', enter: 'left' },
		{ from: 'unresolved', to: 'issue', exit: 'left', enter: 'left' },
		{ from: 'unresolved', to: 'blocked', exit: 'right', enter: 'top' },
	],
}

/** The scheduling step's words before he added the blocked label. */
export const SCHEDULE_BEFORE_BLOCKED = {
	schedule: 'Orchestrator schedules one runner per PR',
}
