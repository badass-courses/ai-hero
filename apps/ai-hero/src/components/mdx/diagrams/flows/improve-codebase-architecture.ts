import type { FlowDiagram, FlowNode } from '../flow'
import { left, right } from './lanes'

const DESCRIPTION =
	'Once a day, provides a set of recommendations for repo improvement.'

/** The top of both designs: the daily runner, and the ticket count that
    stops it before it piles on more. */
const START: readonly FlowNode[] = [
	{
		id: 'spawn',
		roles: ['orchestrator'],
		text: 'Once per 2 days, spawn a runner',
		...left(1),
	},
	{
		id: 'fetch',
		roles: ['tracker'],
		text: 'Fetches existing codebase architecture tickets',
		...right(1),
	},
	{
		id: 'stop',
		roles: ['runner'],
		text: 'Stop if >20 existing tickets',
		...left(2),
	},
	{
		id: 'run',
		roles: ['runner'],
		text: 'Run /improve-codebase-architecture',
		...left(3),
	},
]

/**
 * Matt's /improve-codebase-architecture design, from the lesson's solution,
 * as he finished it: every step lands as a ticket for a human to review. He
 * built it up on camera, so `part-one.tsx` draws earlier frames from it with
 * `stage`; `spawn-run` and `fetch-run` are the arrows from before he added
 * the stop step, and `hidden` the blank end of the arrow he drew off screen
 * before naming its step.
 */
export const improveCodebaseArchitecture: FlowDiagram = {
	title: '/improve-codebase-architecture',
	description: DESCRIPTION,
	nodes: [
		...START,
		{
			id: 'create',
			roles: ['tracker'],
			text: 'Create new labelled tickets (one per candidate)',
			...left(4),
		},
		{
			id: 'review',
			roles: ['human'],
			text: 'Reviews the ticket',
			...left(5),
		},
		{
			id: 'label',
			roles: ['tracker'],
			text: 'Labels the ticket',
			...right(6),
		},
		{ id: 'hidden', roles: [], text: '', ...right(7) },
		{
			id: 'implement',
			roles: ['orchestrator'],
			text: 'Spawns implement agents',
			...right(7),
		},
		{ id: 'more', roles: [], more: true, text: '', ...right(8) },
	],
	edges: [
		{ from: 'spawn', to: 'run', exit: 'left', enter: 'left' },
		{
			from: 'fetch',
			to: 'run',
			exit: 'left',
			enter: 'right',
			// Narrow, the left step's words run under this arrow's start.
			narrow: { exit: 'bottom' },
		},
		{ from: 'spawn', to: 'stop', exit: 'left', enter: 'left' },
		{
			from: 'fetch',
			to: 'stop',
			exit: 'left',
			enter: 'right',
			// Narrow, the left step's words run under this arrow's start.
			narrow: { exit: 'bottom' },
		},
		{ from: 'stop', to: 'run', exit: 'left', enter: 'left' },
		{ from: 'run', to: 'create', exit: 'left', enter: 'left' },
		{ from: 'create', to: 'review', exit: 'left', enter: 'left' },
		{ from: 'review', to: 'label', exit: 'right', enter: 'top' },
		{ from: 'label', to: 'hidden', exit: 'left', enter: 'left' },
		{ from: 'label', to: 'implement', exit: 'left', enter: 'left' },
		{ from: 'implement', to: 'more', exit: 'left', enter: 'left' },
	],
}

/** The arrows the finished design no longer has. */
export const BEFORE_STOP = ['spawn-run', 'fetch-run'] as const

/**
 * The second design, drawn beside the first: a runner decides which tickets
 * are ready, implements those straight away and sends the rest to a human.
 */
export const improveCodebaseArchitectureNoHuman: FlowDiagram = {
	title: '/improve-codebase-architecture (no human)',
	description: DESCRIPTION,
	nodes: [
		...START,
		{
			id: 'verdict',
			roles: ['runner'],
			text: 'Gives verdict on which ones are ready for implementation',
			...left(4),
		},
		{
			id: 'ready',
			roles: ['runner'],
			text: 'For ready-to-go tickets, implement immediately',
			...right(5),
		},
		{
			id: 'create',
			roles: ['tracker'],
			text: 'Create new labelled tickets (one per candidate)',
			...left(5),
		},
		{
			id: 'pr',
			roles: ['git'],
			text: 'Creates a PR for each ticket',
			...right(6),
		},
		{
			id: 'needs-review',
			roles: ['tracker'],
			text: 'For tickets needing human review, also create tickets',
			...left(6),
		},
		{
			id: 'review-pr',
			roles: ['human'],
			text: 'Reviews the PR',
			...right(7),
		},
		{
			id: 'review-ticket',
			roles: ['human'],
			text: 'Reviews the ticket',
			...left(7),
		},
	],
	edges: [
		{ from: 'spawn', to: 'stop', exit: 'left', enter: 'left' },
		{
			from: 'fetch',
			to: 'stop',
			exit: 'left',
			enter: 'right',
			// Narrow, the left step's words run under this arrow's start.
			narrow: { exit: 'bottom' },
		},
		{ from: 'stop', to: 'run', exit: 'left', enter: 'left' },
		{ from: 'run', to: 'verdict', exit: 'left', enter: 'left' },
		{ from: 'verdict', to: 'ready', exit: 'right', enter: 'top' },
		{ from: 'verdict', to: 'create', exit: 'left', enter: 'left' },
		{ from: 'verdict', to: 'needs-review', exit: 'left', enter: 'left' },
		{ from: 'needs-review', to: 'review-ticket', exit: 'left', enter: 'left' },
		{ from: 'ready', to: 'pr', exit: 'left', enter: 'left' },
		{ from: 'pr', to: 'review-pr', exit: 'left', enter: 'left' },
	],
}
