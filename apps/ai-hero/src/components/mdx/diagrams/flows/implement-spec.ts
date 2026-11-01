import type { FlowDiagram, FlowEdge, FlowNode } from '../flow'
import { at, type FrameStep } from './frames'
import { implementSpecV2 } from './implement-spec-v2'

/**
 * Matt's first "Implement Spec" workflow, from the Software Factory Part Two
 * lesson of that name, as he builds it on camera. He later copies it into
 * Implement Spec v2, so every step the two share is v2's, in v2's place;
 * only the frontier half differs. Each frame below is one image in the
 * lesson.
 */

function shared(id: string): FlowNode {
	const node = implementSpecV2.nodes.find((n) => n.id === id)
	if (!node) throw new Error(`Implement Spec v2 has no step "${id}"`)
	return node
}

function sharedEdge(from: string, to: string): FlowEdge {
	const edge = implementSpecV2.edges.find((e) => e.from === from && e.to === to)
	if (!edge) throw new Error(`Implement Spec v2 has no arrow ${from} → ${to}`)
	return edge
}

/** Where the frontier step sits, as v2's "For each frontier ticket". */
const FRONTIER = { wide: { col: 5 }, narrow: { col: 5, span: 6 } }
/** The build runner shares its row with "If not complete…", so on a phone
    it keeps to the columns left of it. */
const BUILD = { wide: { col: 5 }, narrow: { col: 5, span: 4 } }

const step = {
	labelled: shared('labelled'),
	noTickets: shared('no-tickets'),
	hasTickets: shared('has-tickets'),
	toTickets: shared('to-tickets'),
	explore: shared('explore'),
	addsTickets: shared('adds-tickets'),
	saveMarkdown: shared('save-markdown'),
	explorationComment: shared('exploration-comment'),
	triggerFrontier: {
		id: 'frontier',
		roles: ['orchestrator'],
		text: 'Trigger a runner to figure out the frontier',
		...FRONTIER,
	},
	eachUnblocked: {
		id: 'frontier',
		roles: ['orchestrator'],
		text: 'For each unblocked ticket, trigger a runner',
		...FRONTIER,
	},
	fetchFrontier: {
		id: 'frontier',
		roles: ['orchestrator'],
		text: 'Fetch the frontier of tickets',
		...FRONTIER,
	},
	buildMultiple: {
		id: 'build',
		roles: ['runner', 'runner'],
		more: true,
		text: 'Build the tickets in multiple runners',
		...BUILD,
	},
	buildSubagents: {
		id: 'build',
		roles: ['runner'],
		text: 'Build the frontier in subagents',
		...BUILD,
	},
	merge: {
		id: 'merge',
		roles: ['runner'],
		text: 'Merge all the tickets together',
		wide: { col: 5 },
		narrow: { col: 5, span: 4 },
	},
	notComplete: shared('not-complete'),
	closeTickets: shared('close-tickets'),
	saveMerged: shared('save-merged'),
	complete: shared('complete'),
	review: shared('review'),
} satisfies Record<string, FrameStep>

const edge = {
	labelledNo: sharedEdge('labelled', 'no-tickets'),
	labelledHas: sharedEdge('labelled', 'has-tickets'),
	noToTickets: sharedEdge('no-tickets', 'to-tickets'),
	toTicketsAdds: sharedEdge('to-tickets', 'adds-tickets'),
	addsHas: sharedEdge('adds-tickets', 'has-tickets'),
	hasExplore: sharedEdge('has-tickets', 'explore'),
	exploreMarkdown: sharedEdge('explore', 'save-markdown'),
	exploreComment: sharedEdge('explore', 'exploration-comment'),
	exploreFrontier: {
		...sharedEdge('explore', 'for-each'),
		to: 'frontier',
	},
	frontierBuild: { from: 'frontier', to: 'build', exit: 'left', enter: 'left' },
	buildMerge: { from: 'build', to: 'merge', exit: 'left', enter: 'left' },
	mergeNotComplete: sharedEdge('merge', 'not-complete'),
	notCompleteFrontier: {
		...sharedEdge('not-complete', 'for-each'),
		to: 'frontier',
	},
	mergeClose: sharedEdge('merge', 'close-tickets'),
	mergeSaved: sharedEdge('merge', 'save-merged'),
	mergeComplete: sharedEdge('merge', 'complete'),
	completeReview: sharedEdge('complete', 'review'),
} satisfies Record<string, FlowEdge>

const heading = {
	title: 'Implement Spec',
	description: implementSpecV2.description,
}

/** The heading alone, before the first step. */
export const implementSpecHeading: FlowDiagram = {
	...heading,
	nodes: [],
	edges: [],
}

const triage = {
	nodes: [
		at(step.labelled, 1),
		at(step.noTickets, 2),
		at(step.hasTickets, 2),
		at(step.toTickets, 3),
		at(step.addsTickets, 4),
	],
	edges: [
		edge.labelledNo,
		edge.labelledHas,
		edge.noToTickets,
		edge.toTicketsAdds,
	],
}

/** The spec is labelled, and splits on whether it has tickets yet. */
export const implementSpecTriage: FlowDiagram = { ...heading, ...triage }

/** Once tickets are added, the spec joins the other branch. */
export const implementSpecTickets: FlowDiagram = {
	...heading,
	nodes: triage.nodes,
	edges: [...triage.edges, edge.addsHas],
}

/** The exploration step, saved to a branch. */
export const implementSpecExplore: FlowDiagram = {
	...heading,
	nodes: [...triage.nodes, at(step.explore, 3), at(step.saveMarkdown, 4)],
	edges: [...implementSpecTickets.edges, edge.hasExplore, edge.exploreMarkdown],
}

const explored = [
	...implementSpecExplore.edges,
	edge.exploreComment,
	edge.exploreFrontier,
]

/** The exploration comments on the spec and hands over to the frontier. */
export const implementSpecFrontier: FlowDiagram = {
	...heading,
	nodes: [
		...implementSpecExplore.nodes,
		at(step.explorationComment, 5),
		at(step.triggerFrontier, 6),
	],
	edges: explored,
}

/** A runner for every unblocked ticket. */
export const implementSpecRunners: FlowDiagram = {
	...heading,
	nodes: [
		...implementSpecExplore.nodes,
		at(step.explorationComment, 5),
		at(step.eachUnblocked, 6),
		at(step.buildMultiple, 7),
	],
	edges: [...explored, edge.frontierBuild],
}

/** One runner builds the whole frontier in subagents. */
export const implementSpecSubagents: FlowDiagram = {
	...heading,
	nodes: [
		...implementSpecExplore.nodes,
		at(step.explorationComment, 5),
		at(step.fetchFrontier, 6),
		at(step.buildSubagents, 7),
	],
	edges: [...explored, edge.frontierBuild],
}

/** The loop back to the frontier, ending in agent review: the finished
    drawing. */
export const implementSpec: FlowDiagram = {
	...heading,
	nodes: [
		...implementSpecSubagents.nodes,
		at(step.notComplete, 7),
		at(step.merge, 8),
		at(step.closeTickets, 8),
		at(step.complete, 9),
		at(step.saveMerged, 9),
		at(step.review, 10),
	],
	edges: [
		...explored,
		edge.frontierBuild,
		edge.buildMerge,
		edge.mergeNotComplete,
		edge.notCompleteFrontier,
		edge.mergeClose,
		edge.mergeSaved,
		edge.mergeComplete,
		edge.completeReview,
	],
}
