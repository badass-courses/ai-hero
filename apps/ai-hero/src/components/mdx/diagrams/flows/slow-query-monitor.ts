import type { FlowDiagram, FlowEdge } from '../flow'
import { at, type FrameStep } from './frames'

/**
 * Matt's "Slow Query Monitor" workflow, from the Software Factory Part Two
 * lesson of that name, as he builds it on camera. Each frame below is one
 * image in the lesson: the drawing as it stood when he grabbed it. Steps keep
 * their columns from frame to frame; the rows move as he inserts steps.
 */

const LEFT = { wide: { col: 2, span: 4 }, narrow: { col: 2, span: 6 } }
const RIGHT = { wide: { col: 8, span: 4 }, narrow: { col: 8, span: 5 } }
/** The ticket the fix runner writes to sits a little left of the column
    above it. */
const UNDER = { wide: { col: 7, span: 5 }, narrow: { col: 8, span: 5 } }

const step = {
	receives: {
		id: 'receives',
		roles: ['orchestrator'],
		text: 'Receives an alert',
		...LEFT,
	},
	puts: {
		id: 'puts',
		roles: ['orchestrator'],
		text: 'Puts the alert in a queue',
		...LEFT,
	},
	pullQueue: {
		id: 'pull-alerts',
		roles: ['orchestrator'],
		text: 'Once per day, pull the alerts off the queue',
		...LEFT,
	},
	pullApi: {
		id: 'pull-alerts',
		roles: ['orchestrator'],
		text: 'Once per day, pull the alerts from the API',
		...LEFT,
	},
	pullTickets: {
		id: 'pull-tickets',
		roles: ['tracker'],
		text: 'Pull existing slow query tickets',
		...RIGHT,
	},
	group: {
		id: 'group',
		roles: ['runner'],
		text: 'Find groups of alerts that might be related',
		...LEFT,
	},
	ticketEach: {
		id: 'ticket-each',
		roles: ['tracker'],
		text: 'For each group, create a ticket',
		...RIGHT,
	},
	ticketSeverity: {
		id: 'ticket-each',
		roles: ['tracker'],
		text: 'For each group, create a ticket and mark its severity',
		...RIGHT,
	},
	trigger: {
		id: 'trigger',
		roles: ['orchestrator'],
		text: 'For each ticket without a PR , trigger a runner',
		...LEFT,
	},
	triggerSevere: {
		id: 'trigger',
		roles: ['orchestrator'],
		text: 'For each SEVERE ticket without a PR , trigger a runner',
		...LEFT,
	},
	fix: {
		id: 'fix',
		roles: ['runner'],
		text: 'Finds a potential fix for the slow query',
		...LEFT,
	},
	pr: {
		id: 'pr',
		roles: ['git'],
		text: 'Creates a pull request for the fix',
		...LEFT,
	},
	postTicket: {
		id: 'fix-ticket',
		roles: ['tracker'],
		text: 'Post a ticket explaining the fix',
		...UNDER,
	},
	updateTicket: {
		id: 'fix-ticket',
		roles: ['tracker'],
		text: 'Update the ticket',
		...UNDER,
	},
} satisfies Record<string, FrameStep>

const edge = {
	receivesPuts: { from: 'receives', to: 'puts', exit: 'left', enter: 'left' },
	putsPull: { from: 'puts', to: 'pull-alerts', exit: 'left', enter: 'left' },
	pullGroup: { from: 'pull-alerts', to: 'group', exit: 'left', enter: 'left' },
	ticketsGroup: {
		from: 'pull-tickets',
		to: 'group',
		exit: 'left',
		enter: 'right',
		// On a phone the diagonal would cut through the step beside it.
		narrow: { exit: 'bottom' },
	},
	groupTicket: {
		from: 'group',
		to: 'ticket-each',
		exit: 'right',
		enter: 'left',
	},
	groupTrigger: { from: 'group', to: 'trigger', exit: 'left', enter: 'left' },
	triggerFix: { from: 'trigger', to: 'fix', exit: 'left', enter: 'left' },
	fixPr: { from: 'fix', to: 'pr', exit: 'left', enter: 'left' },
	fixTicket: { from: 'fix', to: 'fix-ticket', exit: 'right', enter: 'top' },
} satisfies Record<string, FlowEdge>

const heading = {
	title: 'Slow Query Monitor',
	description: 'Turn slow query monitor alerts into fix PR’s',
}

/** The heading alone, before the first step. */
export const slowQueryHeading: FlowDiagram = {
	...heading,
	nodes: [],
	edges: [],
}

/** The trigger. */
export const slowQueryAlert: FlowDiagram = {
	...heading,
	nodes: [at(step.receives, 1)],
	edges: [],
}

/** The fix runner and its pull request, not yet joined to the alert. */
export const slowQueryFix: FlowDiagram = {
	...heading,
	nodes: [at(step.receives, 1), at(step.fix, 2), at(step.pr, 3)],
	edges: [edge.fixPr],
}

/** The fix runner also posts a ticket. */
export const slowQueryFixTicket: FlowDiagram = {
	...heading,
	nodes: [
		at(step.receives, 1),
		at(step.fix, 2),
		at(step.pr, 3),
		at(step.postTicket, 3),
	],
	edges: [edge.fixPr, edge.fixTicket],
}

/** Alerts queue up and a daily runner groups them into tickets. */
export const slowQueryGroups: FlowDiagram = {
	...heading,
	nodes: [
		at(step.receives, 1),
		at(step.puts, 2),
		at(step.pullQueue, 3),
		at(step.group, 4),
		at(step.ticketEach, 4),
		at(step.fix, 5),
		at(step.pr, 6),
		at(step.postTicket, 6),
	],
	edges: [
		edge.receivesPuts,
		edge.putsPull,
		edge.pullGroup,
		edge.groupTicket,
		edge.fixPr,
		edge.fixTicket,
	],
}

/** The grouping runner also reads the tickets that already exist. */
export const slowQueryExisting: FlowDiagram = {
	...slowQueryGroups,
	nodes: [
		at(step.receives, 1),
		at(step.puts, 2),
		at(step.pullQueue, 3),
		at(step.pullTickets, 3),
		at(step.group, 4),
		at(step.ticketEach, 4),
		at(step.fix, 5),
		at(step.pr, 6),
		at(step.postTicket, 6),
	],
	edges: [...slowQueryGroups.edges, edge.ticketsGroup],
}

const triggered = {
	edges: [
		edge.receivesPuts,
		edge.putsPull,
		edge.pullGroup,
		edge.ticketsGroup,
		edge.groupTicket,
		edge.groupTrigger,
		edge.triggerFix,
		edge.fixPr,
		edge.fixTicket,
	],
}

/** The orchestrator joins the groups to the fix runner. */
export const slowQueryTrigger: FlowDiagram = {
	...heading,
	nodes: [
		at(step.receives, 1),
		at(step.puts, 2),
		at(step.pullQueue, 3),
		at(step.pullTickets, 3),
		at(step.group, 4),
		at(step.ticketEach, 4),
		at(step.trigger, 5),
		at(step.fix, 6),
		at(step.pr, 7),
		at(step.postTicket, 7),
	],
	...triggered,
}

/** The fix runner updates the group's ticket instead of posting a new one. */
export const slowQueryUpdate: FlowDiagram = {
	...slowQueryTrigger,
	nodes: [
		at(step.receives, 1),
		at(step.puts, 2),
		at(step.pullQueue, 3),
		at(step.pullTickets, 3),
		at(step.group, 4),
		at(step.ticketEach, 4),
		at(step.trigger, 5),
		at(step.fix, 6),
		at(step.pr, 7),
		at(step.updateTicket, 7),
	],
}

const daily = {
	edges: [
		edge.pullGroup,
		edge.ticketsGroup,
		edge.groupTicket,
		edge.groupTrigger,
		edge.triggerFix,
		edge.fixPr,
		edge.fixTicket,
	],
}

/** No queue: the orchestrator pulls the day's alerts from the API. */
export const slowQueryApi: FlowDiagram = {
	...heading,
	nodes: [
		at(step.pullApi, 1),
		at(step.pullTickets, 1),
		at(step.group, 2),
		at(step.ticketEach, 2),
		at(step.trigger, 3),
		at(step.fix, 4),
		at(step.pr, 5),
		at(step.updateTicket, 5),
	],
	...daily,
}

/** Only severe tickets get a fix runner. */
export const slowQuerySevere: FlowDiagram = {
	...heading,
	nodes: [
		at(step.pullApi, 1),
		at(step.pullTickets, 1),
		at(step.group, 2),
		at(step.ticketEach, 2),
		at(step.triggerSevere, 3),
		at(step.fix, 4),
		at(step.pr, 5),
		at(step.updateTicket, 5),
	],
	...daily,
}

/** Each group's ticket carries its severity: the finished drawing. */
export const slowQueryMonitor: FlowDiagram = {
	...heading,
	nodes: [
		at(step.pullApi, 1),
		at(step.pullTickets, 1),
		at(step.group, 2),
		at(step.ticketSeverity, 2),
		at(step.triggerSevere, 3),
		at(step.fix, 4),
		at(step.pr, 5),
		at(step.updateTicket, 5),
	],
	...daily,
}
