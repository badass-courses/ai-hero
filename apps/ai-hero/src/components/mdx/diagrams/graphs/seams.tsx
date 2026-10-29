import type { GraphDiagram, GraphEdge, GraphNode } from './graph'
import { ModuleBox, Note } from './parts'

/**
 * Matt's seam and adapter drawings, from "Seams & Adapters" and "The Improve
 * Codebase Architecture Skill". Boxes are modules; the blue dashes are seams.
 * Each box spans two grid rows so a neighbour can start halfway down it, the
 * way his boxes sit offset from each other.
 */

const SEAM_TEXT = "The location at which a module's interface lives."
const ADAPTER_TEXT = 'A concrete thing that satisfies an interface at a seam.'

function box(
	id: string,
	wide: GraphNode['wide'],
	narrow: GraphNode['narrow'],
	label?: string,
	body = 'h-24',
): GraphNode {
	return {
		id,
		name: label,
		content: <ModuleBox label={label} className={body} />,
		wide: { rows: 2, ...wide },
		narrow: narrow && { rows: 2, ...narrow },
	}
}

function note(
	id: string,
	title: string,
	text: string,
	wide: GraphNode['wide'],
	narrow?: GraphNode['narrow'],
): GraphNode {
	return {
		id,
		content: <Note align="end" title={title} text={text} className="max-w-[12rem]" />,
		wide: { justify: 'end', ...wide },
		narrow: narrow && { justify: 'end', ...narrow },
	}
}

/** On a phone a seam's label sits level with the seam, so its pointer runs
    straight across from the label's side. The empty part is the whole label:
    an undefined one would not survive the trip to the client. */
const BESIDE: GraphEdge['narrow'] = {
	from: { side: 'right', part: '', at: 0.5 },
}

function pointer(from: string, to: GraphEdge['to'], narrow?: GraphEdge['narrow']): GraphEdge {
	return {
		from: { id: from, side: 'top', part: 'title', at: 0.85 },
		to,
		ink: 'note',
		shape: 'curve',
		narrow,
	}
}

/** Four modules calling each other, a seam across every call. */
export const seamMap: GraphDiagram = {
	className: 'max-w-[46rem]',
	nodes: [
		box('a', { col: 5, row: 1, span: 2 }, { col: 4, row: 1, span: 4 }, undefined, 'h-16'),
		box('b', { col: 10, row: 2, span: 2 }, { col: 9, row: 2, span: 4 }, undefined, 'h-16'),
		box('c', { col: 7, row: 4, span: 2 }, { col: 5, row: 4, span: 4 }, undefined, 'h-16'),
		box('d', { col: 10, row: 5, span: 2 }, { col: 10, row: 5, span: 3 }, undefined, 'h-16'),
		note(
			'seam-note',
			'Seam',
			SEAM_TEXT,
			{ col: 1, row: 4, span: 5, rows: 2, align: 'center' },
			{ col: 1, row: 3, span: 4, justify: 'start' },
		),
	],
	edges: [
		{
			from: { id: 'a', side: 'right', at: 0.48 },
			to: { id: 'b', side: 'left', at: 0.45 },
			shape: 'curve',
			narrow: { from: { at: 0.85 }, to: { at: 0.3 } },
		},
		{
			from: { id: 'a', side: 'bottom', at: 0.8 },
			to: { id: 'c', side: 'top', at: 0.25 },
			narrow: { to: { at: 0.5 } },
		},
		{ from: { id: 'b', side: 'bottom', at: 0.05 }, to: { id: 'c', side: 'top', at: 0.95 } },
		{ from: { id: 'c', side: 'right', at: 0.8 }, to: { id: 'd', side: 'left', at: 0.3 } },
		pointer('seam-note', { id: 'seam-ac', side: 'left' }, BESIDE),
	],
	seams: [
		{ id: 'seam-ab', crosses: ['a-b'] },
		{ id: 'seam-ac', crosses: ['a-c'] },
		{ id: 'seam-bc', crosses: ['b-c'] },
		{ id: 'seam-cd', crosses: ['c-d'] },
	],
}

/** A caller reaching a module across one call, before any seam is drawn. */
export const loaderToDatabase: GraphDiagram = {
	className: 'max-w-[46rem]',
	nodes: [
		box('loader', { col: 1, row: 1, span: 3 }, { col: 1, row: 1, span: 5 }, 'Loader', 'h-28'),
		box(
			'access',
			{ col: 9, row: 2, span: 4 },
			{ col: 7, row: 2, span: 6 },
			'access.server.ts',
			'h-28',
		),
		box(
			'database',
			{ col: 5, row: 5, span: 3 },
			{ col: 4, row: 5, span: 5 },
			'Database',
			'h-28',
		),
	],
	edges: [
		{
			from: { id: 'loader', side: 'right', at: 0.48 },
			to: { id: 'access', side: 'left', at: 0.42 },
			shape: 'curve',
		},
		{
			from: { id: 'access', side: 'left', at: 0.85 },
			to: { id: 'database', side: 'top', at: 0.55 },
			shape: 'curve',
		},
	],
}

/**
 * One module with a seam in front of the two adapters that can stand
 * behind it, the live one and the test one. Drawn for access.server.ts with
 * its Loader caller, and for daysSince with real and fake time.
 */
export function seamSwap({
	caller,
	module,
	live,
	fake,
}: {
	caller?: string
	module: string
	live: string
	fake: string
}): GraphDiagram {
	const top = caller ? 2 : 1
	const nodes: GraphNode[] = [
		box(
			'module',
			{ col: 9, row: top, span: 4 },
			{ col: 7, row: top, span: 6 },
			module,
		),
		note(
			'seam-note',
			'Seam',
			SEAM_TEXT,
			{ col: 1, row: top + 2, span: 5 },
			{ col: 1, row: top + 2, span: 4, justify: 'start' },
		),
		box('live', { col: 5, row: top + 3, span: 3 }, { col: 1, row: top + 3, span: 6 }, live),
		box('fake', { col: 9, row: top + 3, span: 3 }, { col: 7, row: top + 3, span: 6 }, fake),
		note(
			'adapter-note',
			'Adapter',
			ADAPTER_TEXT,
			{ col: 1, row: top + 4, span: 3, align: 'end' },
			{ col: 1, row: top + 5, span: 7, justify: 'start' },
		),
	]
	const edges: GraphEdge[] = [
		{
			from: { id: 'module', side: 'left', at: 0.8 },
			to: { id: 'live', side: 'top', at: 0.55 },
			shape: 'curve',
			// On a phone both arrows drop from the module's foot, clear of
			// the seam's label on the left.
			narrow: { from: { side: 'bottom', at: 0.2 }, to: { at: 0.9 } },
		},
		{
			from: { id: 'module', side: 'bottom', at: 0.4 },
			to: { id: 'fake', side: 'top', at: 0.3 },
			shape: 'curve',
			narrow: { from: { at: 0.6 }, to: { at: 0.5 } },
		},
		pointer('seam-note', { id: 'seam', side: 'left' }, BESIDE),
		pointer(
			'adapter-note',
			{ id: 'live', side: 'left', at: 0.45 },
			{ from: { at: 0.5 }, to: { side: 'bottom', at: 0.75 } },
		),
	]
	if (caller) {
		nodes.unshift(
			box('caller', { col: 2, row: 1, span: 3 }, { col: 1, row: 1, span: 5 }, caller),
		)
		edges.unshift({
			from: { id: 'caller', side: 'right', at: 0.45 },
			to: { id: 'module', side: 'left', at: 0.42 },
			shape: 'curve',
		})
	}
	return {
		className: 'max-w-[46rem]',
		nodes,
		edges,
		seams: [{ id: 'seam', crosses: ['module-live', 'module-fake'] }],
	}
}
