import type { FlowDiagram } from '../flow'
import { left, right } from './lanes'

/**
 * Matt's Lint Rule Ratchet, from The Ratchet's solution. He built it up on
 * camera and changed his mind on the way, so this holds every step he drew:
 * `on-merge` is the trigger he tried and later deleted, `after-stop` and
 * `after-find` the blank ends of arrows he drew before naming their steps.
 * `part-one.tsx` picks each frame out with `stage`.
 */
export const lintRuleRatchet: FlowDiagram = {
	title: 'Lint Rule Ratchet',
	description:
		'Once a day, find a failing lint rule and make a PR to fix one instance of it',
	nodes: [
		{
			id: 'spawn',
			roles: ['orchestrator'],
			text: 'Once a day, spawn a runner',
			...left(1),
		},
		{
			id: 'fetch',
			roles: ['git'],
			text: 'Fetch existing ratchet PR’s',
			...right(1),
		},
		{
			id: 'stop',
			roles: ['runner'],
			text: 'Stop if >5 existing PRs',
			...left(2),
		},
		{
			id: 'scripts',
			roles: [],
			code: true,
			text: 'npm run lint:strict',
			wide: { col: 8, row: 2, span: 5 },
			// Clear of the arrow from "Fetch existing ratchet PR's", which drops
			// straight down on a phone.
			narrow: { col: 10, row: 2, span: 3 },
		},
		{ id: 'after-stop', roles: [], text: '', ...left(3) },
		{
			id: 'find',
			roles: ['runner'],
			text: 'Run lint rules and find failures',
			...left(3),
		},
		{
			id: 'on-merge',
			roles: ['orchestrator'],
			text: 'On merge, spawn another runner',
			// Further out than the other side steps, as Matt has it, so the
			// arrow up from "Merges the PR" passes clear of the step above.
			wide: { col: 10, row: 3, span: 3 },
			narrow: { col: 8, row: 3, span: 5 },
		},
		{ id: 'after-find', roles: [], text: '', ...left(4) },
		{
			id: 'fix',
			roles: ['runner'],
			text: 'Fix one failure',
			...left(4),
		},
		{
			id: 'graduate',
			roles: ['runner'],
			text: 'If none fail, graduate to lint:strict',
			...right(4),
		},
		{
			id: 'pr',
			roles: ['git'],
			text: 'Make a PR with the failure, with the ratchet label',
			...left(5),
		},
		{
			id: 'graduation-pr',
			roles: ['git'],
			text: 'Make a PR with the graduation',
			...right(5),
		},
		{
			id: 'human',
			roles: ['human'],
			text: 'Merges the PR',
			...left(6),
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
		{ from: 'stop', to: 'after-stop', exit: 'left', enter: 'left' },
		{ from: 'stop', to: 'find', exit: 'left', enter: 'left' },
		{ from: 'find', to: 'after-find', exit: 'left', enter: 'left' },
		{ from: 'find', to: 'fix', exit: 'left', enter: 'left' },
		{ from: 'find', to: 'graduate', exit: 'right', enter: 'top' },
		{ from: 'fix', to: 'pr', exit: 'left', enter: 'left' },
		{ from: 'pr', to: 'human', exit: 'left', enter: 'left' },
		{ from: 'graduate', to: 'graduation-pr', exit: 'left', enter: 'left' },
		{ from: 'graduation-pr', to: 'human', exit: 'bottom', enter: 'right' },
		{ from: 'human', to: 'on-merge', exit: 'right', enter: 'bottom' },
		{ from: 'on-merge', to: 'stop', exit: 'top', enter: 'right' },
	],
}
