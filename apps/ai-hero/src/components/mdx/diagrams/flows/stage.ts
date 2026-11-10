import type { FlowDiagram, FlowNode, FlowPlace } from '../flow'

/**
 * One frame of a drawing Matt built up on camera: only the steps that were
 * there by then, with the words they had then, and only the arrows between
 * them. Rows left empty by a step he had yet to add close up, the way his
 * drawing did before he made room for it.
 */
export function stage(
	diagram: FlowDiagram,
	{
		nodes,
		text = {},
		without = [],
	}: {
		/** The ids of the steps already drawn. */
		nodes: readonly string[]
		/** Steps whose words he changed later, with their words in this frame. */
		text?: Readonly<Record<string, string>>
		/** Arrows (`from-to`) not drawn yet although both their steps are. */
		without?: readonly string[]
	},
): FlowDiagram {
	const kept = diagram.nodes.filter((node) => nodes.includes(node.id))
	const wideRow = dense(kept.map((node) => node.wide.row))
	const narrowRow = dense(kept.map((node) => (node.narrow ?? node.wide).row))
	const closeUp = (place: FlowPlace, rows: Map<number, number>) => ({
		...place,
		row: rows.get(place.row)!,
	})

	return {
		...diagram,
		nodes: kept.map(
			(node): FlowNode => ({
				...node,
				text: text[node.id] ?? node.text,
				wide: closeUp(node.wide, wideRow),
				narrow: closeUp(node.narrow ?? node.wide, narrowRow),
			}),
		),
		edges: diagram.edges.filter(
			(edge) =>
				nodes.includes(edge.from) &&
				nodes.includes(edge.to) &&
				!without.includes(`${edge.from}-${edge.to}`),
		),
	}
}

/** Each row number mapped to its rank among the rows in use. */
function dense(rows: readonly number[]) {
	const sorted = [...new Set(rows)].sort((a, b) => a - b)
	return new Map(sorted.map((row, i) => [row, i + 1]))
}
