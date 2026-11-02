import type { FlowDiagram } from '../flow'
import { left, right } from './lanes'

/**
 * Matt's "Explore Tickets" example, from Whiteboard Your Own Tasks. Both
 * grabs cut it off under "If it's an easy call", where the next step's words
 * sit behind tldraw's toolbar, so the arrow there leads to a blank step
 * rather than to words he never showed.
 */
export const exploreTickets: FlowDiagram = {
	title: 'Explore Tickets',
	description: 'Explores tickets and gets them ready for implementation',
	nodes: [
		{
			id: 'labels',
			roles: ['tracker'],
			text: 'User labels multiple tickets as agent:explore',
			...left(1),
		},
		{
			id: 'schedules',
			roles: ['orchestrator'],
			text: 'Schedules a runner',
			...left(2),
		},
		{
			id: 'groups',
			roles: ['runner'],
			text: 'Groups tickets',
			...left(3),
		},
		{
			id: 'dispatches',
			roles: ['runner'],
			text: 'For each group, dispatches a subagent',
			...left(4),
		},
		{
			id: 'verdict',
			roles: ['runner'],
			text: 'Delivers a verdict',
			...left(5),
		},
		{
			id: 'easy-call',
			roles: ['orchestrator'],
			text: 'If it’s an easy call, implement it',
			...right(6),
		},
		{
			id: 'writes-back',
			roles: ['tracker'],
			text: 'Writes back a comment to the ticket',
			...left(6),
		},
		{ id: 'hidden', roles: [], text: '', ...right(7) },
	],
	edges: [
		{ from: 'labels', to: 'schedules', exit: 'left', enter: 'left' },
		{ from: 'schedules', to: 'groups', exit: 'left', enter: 'left' },
		{ from: 'groups', to: 'dispatches', exit: 'left', enter: 'left' },
		{ from: 'dispatches', to: 'verdict', exit: 'left', enter: 'left' },
		{ from: 'verdict', to: 'easy-call', exit: 'right', enter: 'top' },
		{ from: 'verdict', to: 'writes-back', exit: 'left', enter: 'left' },
		{ from: 'easy-call', to: 'hidden', exit: 'left', enter: 'left' },
	],
}
