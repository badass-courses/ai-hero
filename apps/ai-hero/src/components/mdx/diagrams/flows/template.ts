import type { FlowDiagram, FlowNode } from '../flow'

const DESCRIPTION = 'Some nice description goes in here'

/** The legend: one step per role, in two columns as on Matt's board. */
const LEGEND: readonly FlowNode[] = [
	{
		id: 'human',
		roles: ['human'],
		text: DESCRIPTION,
		wide: { col: 1, row: 1, span: 6 },
	},
	{
		id: 'tracker',
		roles: ['tracker'],
		text: DESCRIPTION,
		wide: { col: 7, row: 1, span: 6 },
	},
	{
		id: 'runner',
		roles: ['runner'],
		text: DESCRIPTION,
		wide: { col: 1, row: 2, span: 6 },
	},
	{
		id: 'git',
		roles: ['git'],
		text: DESCRIPTION,
		wide: { col: 7, row: 2, span: 6 },
	},
	{
		id: 'orchestrator',
		roles: ['orchestrator'],
		text: DESCRIPTION,
		wide: { col: 1, row: 3, span: 6 },
	},
]

/** A blank end for the sample arrow, which joins no steps. */
const end = (id: string, col: number, row: number): FlowNode => ({
	id,
	roles: [],
	text: '',
	wide: { col, row, span: 1 },
})

const dots = (col: number, row: number): FlowNode => ({
	id: 'dots',
	roles: [],
	more: true,
	text: '',
	wide: { col, row, span: 2 },
})

const TEMPLATE = {
	title: 'Title',
	description: 'And a cool subtitle if you’re really feeling fancy',
} as const

/**
 * The column Matt's tldraw template keeps beside every drawing: a title, a
 * subtitle, a step for each role, and a sample arrow with an ellipsis. In
 * the earlier boards the arrow arcs over to the right with the ellipsis
 * under its start.
 */
export const templateArcOver: FlowDiagram = {
	...TEMPLATE,
	nodes: [...LEGEND, end('arc-from', 7, 3), end('arc-to', 10, 4), dots(7, 4)],
	edges: [{ from: 'arc-from', to: 'arc-to', exit: 'right', enter: 'top' }],
}

/** The later boards: the arrow bows down on the left, the ellipsis beside it. */
export const templateArcDown: FlowDiagram = {
	...TEMPLATE,
	nodes: [...LEGEND, end('arc-from', 8, 3), end('arc-to', 8, 4), dots(10, 3)],
	edges: [{ from: 'arc-from', to: 'arc-to', exit: 'left', enter: 'left' }],
}
