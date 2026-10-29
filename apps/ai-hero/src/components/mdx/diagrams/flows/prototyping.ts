import type { FlowDiagram, FlowEdge } from '../flow'
import { at, type FrameStep } from './frames'

/**
 * Matt's "Prototyping" workflow, from the Software Factory Part Two lesson of
 * that name, as he builds it on camera. Each frame below is one image in the
 * lesson. Steps keep their columns from frame to frame; the rows move as he
 * inserts steps, and one comment moves to hang off a different runner.
 */

const LEFT = { wide: { col: 2, span: 4 }, narrow: { col: 2, span: 4 } }
const MIDDLE = { wide: { col: 6, span: 3 }, narrow: { col: 7, span: 5 } }
/** On a phone the implement runner sits clear of the line dropping from
    "If simple…" beside it. */
const RIGHT = { wide: { col: 10, span: 3 }, narrow: { col: 9, span: 4 } }
/** The two comments that loop back in share the right column, clear of the
    human's loop up to them. */
const INNER = { wide: { col: 10, span: 3 }, narrow: { col: 7, span: 5 } }

const step = {
	explore: {
		id: 'explore',
		roles: ['runner'],
		text: 'Agent explores a feature request',
		...LEFT,
	},
	simple: { id: 'simple', roles: ['runner'], text: 'If simple…', ...MIDDLE },
	complex: {
		id: 'complex',
		roles: ['tracker'],
		text: 'If complex, post a comment on the ticket',
		...LEFT,
	},
	implement: {
		id: 'implement',
		roles: ['orchestrator'],
		text: 'Kick off an implement runner',
		...RIGHT,
	},
	simpleComment: {
		id: 'simple-comment',
		roles: ['tracker'],
		text: 'Post a comment on the tracker',
		...MIDDLE,
	},
	needed: { id: 'needed', roles: ['runner'], text: 'If a prototype needed…', ...LEFT },
	tagged: {
		id: 'tagged',
		roles: ['tracker'],
		text: 'Human tags an issue as "needs prototype"',
		...INNER,
	},
	kickOff: {
		id: 'kick-off',
		roles: ['orchestrator'],
		text: 'Kick off a prototype runner',
		...LEFT,
	},
	followUp: {
		id: 'follow-up',
		roles: ['tracker'],
		text: 'Post a follow-up comment, tagging the agent',
		...INNER,
	},
	create: { id: 'create', roles: ['runner'], text: 'Create the prototype', ...LEFT },
	createUpdate: {
		id: 'create',
		roles: ['runner'],
		text: 'Create/update the prototype',
		...LEFT,
	},
	comment: {
		id: 'comment',
		roles: ['tracker'],
		text: 'Post a comment on the tracker',
		...MIDDLE,
	},
	draft: {
		id: 'draft',
		roles: ['git'],
		text: 'Save the prototype as a draft PR',
		...LEFT,
	},
	reacts: {
		id: 'reacts',
		roles: ['human'],
		text: 'Reacts to the prototype',
		...MIDDLE,
	},
} satisfies Record<string, FrameStep>

const edge = {
	exploreSimple: { from: 'explore', to: 'simple', exit: 'right', enter: 'top' },
	exploreComplex: { from: 'explore', to: 'complex', exit: 'left', enter: 'left' },
	exploreNeeded: { from: 'explore', to: 'needed', exit: 'left', enter: 'left' },
	simpleImplement: { from: 'simple', to: 'implement', exit: 'right', enter: 'top' },
	simpleComment: {
		from: 'simple',
		to: 'simple-comment',
		exit: 'left',
		enter: 'left',
		// On a phone a bow to the left would run through the step beside it.
		narrow: { exit: 'bottom', enter: 'top' },
	},
	neededKickOff: { from: 'needed', to: 'kick-off', exit: 'left', enter: 'left' },
	neededComment: { from: 'needed', to: 'comment', exit: 'right', enter: 'top' },
	taggedKickOff: { from: 'tagged', to: 'kick-off', exit: 'left', enter: 'top' },
	kickOffCreate: { from: 'kick-off', to: 'create', exit: 'left', enter: 'left' },
	followUpKickOff: { from: 'follow-up', to: 'kick-off', exit: 'left', enter: 'right' },
	createComment: { from: 'create', to: 'comment', exit: 'right', enter: 'top' },
	createDraft: { from: 'create', to: 'draft', exit: 'left', enter: 'left' },
	draftReacts: { from: 'draft', to: 'reacts', exit: 'bottom', enter: 'left' },
	commentReacts: { from: 'comment', to: 'reacts', exit: 'bottom', enter: 'top' },
	reactsFollowUp: {
		from: 'reacts',
		to: 'follow-up',
		exit: 'right',
		enter: 'bottom',
		// A phone has no room to the right for Matt's loop, so it climbs the
		// edge and arrives at the badge's side.
		narrow: { enter: 'right' },
	},
} satisfies Record<string, FlowEdge>

const heading = {
	title: 'Prototyping',
	description: 'Automatically turn exploration into prototypes',
}

/** The exploration that starts it. */
export const prototypingStart: FlowDiagram = {
	...heading,
	nodes: [at(step.explore, 1)],
	edges: [],
}

const branches = {
	nodes: [
		at(step.explore, 1),
		at(step.simple, 2),
		at(step.complex, 3),
		at(step.implement, 3),
		at(step.simpleComment, 4),
	],
	edges: [edge.exploreSimple, edge.exploreComplex, edge.simpleImplement, edge.simpleComment],
}

/** The exploration's branches, with a new one for when a prototype is
    needed. */
export const prototypingNeeded: FlowDiagram = {
	...heading,
	nodes: [...branches.nodes, at(step.needed, 5)],
	edges: [...branches.edges, edge.exploreNeeded],
}

/** A prototype runner creates the prototype; the exploring runner
    comments. */
export const prototypingCreate: FlowDiagram = {
	...heading,
	nodes: [
		...prototypingNeeded.nodes,
		at(step.kickOff, 6),
		at(step.comment, 6),
		at(step.create, 7),
	],
	edges: [
		...prototypingNeeded.edges,
		edge.neededKickOff,
		edge.neededComment,
		edge.kickOffCreate,
	],
}

const created = [
	...prototypingNeeded.edges,
	edge.neededKickOff,
	edge.kickOffCreate,
	edge.createComment,
	edge.createDraft,
]

/** The prototype is saved as a draft PR, and the comment now comes from the
    runner that made it. */
export const prototypingDraft: FlowDiagram = {
	...heading,
	nodes: [
		...prototypingNeeded.nodes,
		at(step.kickOff, 6),
		at(step.create, 7),
		at(step.comment, 8),
		at(step.draft, 9),
	],
	edges: created,
}

/** A human reacts to the draft. */
export const prototypingReacts: FlowDiagram = {
	...heading,
	nodes: [...prototypingDraft.nodes, at(step.reacts, 10)],
	edges: [...created, edge.draftReacts, edge.commentReacts],
}

const looped = [
	...created,
	edge.draftReacts,
	edge.commentReacts,
	edge.reactsFollowUp,
	edge.followUpKickOff,
]

/** The human's follow-up comment runs the prototype runner again. */
export const prototypingFollowUp: FlowDiagram = {
	...heading,
	nodes: [
		...prototypingNeeded.nodes,
		at(step.kickOff, 6),
		at(step.followUp, 7),
		at(step.create, 8),
		at(step.comment, 9),
		at(step.draft, 10),
		at(step.reacts, 11),
	],
	edges: looped,
}

/** Run again, the runner updates the prototype it made. */
export const prototypingUpdate: FlowDiagram = {
	...heading,
	nodes: [
		...prototypingNeeded.nodes,
		at(step.kickOff, 6),
		at(step.followUp, 7),
		at(step.createUpdate, 8),
		at(step.comment, 9),
		at(step.draft, 10),
		at(step.reacts, 11),
	],
	edges: looped,
}

/** A human can ask for a prototype too: the finished drawing. */
export const prototyping: FlowDiagram = {
	...heading,
	nodes: [
		...prototypingNeeded.nodes,
		// Under the runner it sits beside in Matt's drawing, so its arrow
		// passes below that runner's words.
		at(step.tagged, 6),
		at(step.kickOff, 7),
		at(step.followUp, 8),
		at(step.createUpdate, 9),
		at(step.comment, 10),
		at(step.draft, 11),
		at(step.reacts, 12),
	],
	edges: [...looped, edge.taggedKickOff],
}
