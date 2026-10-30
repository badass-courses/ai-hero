import type { GraphDiagram, GraphEdge, GraphNode } from './graph'
import { Command, Destination, Ticket, Unknown } from './parts'

/**
 * Matt's Wayfinder maps, from "Charting the Way" and "Grill vs Wayfinder vs
 * Ship First". Each drawing is defined once here and every video frame is a
 * call with that frame's state: which tickets exist yet, which are ticked,
 * which are greyed out as blocked.
 */

type Done = readonly number[]

function ticket(
	n: number,
	label: string,
	done: Done,
	place: Pick<GraphNode, 'wide' | 'narrow'>,
): GraphNode {
	return {
		id: `t${n}`,
		name: `#${n} ${label}`,
		content: <Ticket n={n} label={label} done={done.includes(n)} />,
		...place,
	}
}

/** The dashed connector from the map down and across to one of its tickets. */
function child(n: number): GraphEdge {
	return {
		from: { id: 't1', side: 'bottom', at: 0.14 },
		to: { id: `t${n}`, side: 'left' },
		shape: 'elbow',
		dashed: true,
		headless: true,
	}
}

/**
 * The map as a tree: #1 Map with tickets #2 to #4 under it. With `toSpec`,
 * the frame where the resolved map goes through /to-spec into #5 Spec.
 */
export function mapTree({
	done = [],
	toSpec = false,
}: { done?: Done; toSpec?: boolean } = {}): GraphDiagram {
	const childCol = toSpec ? 2 : 3
	const children = [2, 3, 4].map((n, i) =>
		ticket(n, 'Ticket', done, {
			wide: { col: childCol, row: i + 2 },
			narrow: { col: childCol, row: i + 2 },
		}),
	)
	const map = ticket(1, 'Map', done, { wide: { col: 1, row: 1 } })
	if (!toSpec) {
		return {
			className: 'max-w-[22rem] gap-y-5 @2xl:gap-y-6',
			nodes: [map, ...children],
			edges: [child(2), child(3), child(4)],
		}
	}
	return {
		className: 'max-w-[40rem] gap-y-5 @2xl:gap-y-6',
		nodes: [
			map,
			...children,
			{
				id: 'to-spec',
				content: <Command>/to-spec</Command>,
				wide: { col: 6, row: 1, align: 'center' },
				narrow: { col: 8, row: 1, align: 'center' },
			},
			ticket(5, 'Spec', done, {
				wide: { col: 9, row: 1 },
				// Beside the tree there is no room on a phone, so the spec drops
				// below it, still on the line out of /to-spec.
				narrow: { col: 7, row: 5 },
			}),
		],
		edges: [
			child(2),
			child(3),
			child(4),
			{
				from: { id: 't1', side: 'right' },
				to: { id: 'to-spec', side: 'left' },
			},
			{
				from: { id: 'to-spec', side: 'right' },
				to: { id: 't5', side: 'left' },
				narrow: {
					from: { side: 'bottom', at: 0.4 },
					to: { side: 'top', at: 0.45 },
				},
			},
		],
	}
}

/** What sits under #4 in each version of the dependency map. */
type Route = 'unknown' | 'found-one' | 'found-all'

/**
 * The map as a dependency graph: #2 and #3 both block #4, and the way on
 * from #4 to the destination is unknown, partly found, or fully found.
 * `labels` names the tickets #2 to #6 in order.
 */
export function roadmap({
	route,
	labels = ['Ticket', 'Ticket', 'Ticket', 'Ticket', 'Ticket'],
	done = [],
	blocked = [],
}: {
	route: Route
	labels?: readonly string[]
	done?: Done
	blocked?: readonly number[]
}): GraphDiagram {
	const at = (n: number, place: Pick<GraphNode, 'wide' | 'narrow'>) => ({
		...ticket(n, labels[n - 2]!, done, place),
		dim: blocked.includes(n),
	})
	const nodes: GraphNode[] = [
		at(2, { wide: { col: 1, row: 1 } }),
		at(3, { wide: { col: 7, row: 1 } }),
		at(4, { wide: { col: 1, row: 2 } }),
	]
	const edges: GraphEdge[] = [
		{
			from: { id: 't2', side: 'bottom', at: 0.14 },
			to: { id: 't4', side: 'top', at: 0.14 },
		},
		{
			from: { id: 't3', side: 'bottom', at: 0.14 },
			to: { id: 't4', side: 'top', at: 0.33 },
		},
	]
	const unknown = (row: number): GraphNode => ({
		id: 'unknown',
		name: '???',
		content: <Unknown />,
		wide: { col: 6, row },
	})
	const destination = (row: number): GraphNode => ({
		id: 'destination',
		name: 'Destination',
		content: <Destination />,
		wide: { col: 5, row },
	})
	const arrow = (
		from: string,
		to: string,
		fromAt: number,
		toAt: number,
	): GraphEdge => ({
		from: { id: from, side: 'bottom', at: fromAt },
		to: { id: to, side: 'top', at: toAt },
	})

	if (route === 'unknown') {
		nodes.push(unknown(3), destination(4))
		edges.push(
			arrow('t4', 'unknown', 0.22, 0.05),
			arrow('unknown', 'destination', 0.5, 0.42),
		)
	} else if (route === 'found-one') {
		nodes.push(at(5, { wide: { col: 5, row: 3 } }), unknown(4), destination(5))
		edges.push(
			arrow('t4', 't5', 0.22, 0.2),
			arrow('t5', 'unknown', 0.45, 0.5),
			arrow('unknown', 'destination', 0.5, 0.42),
		)
	} else {
		nodes.push(
			at(5, { wide: { col: 5, row: 3 } }),
			at(6, { wide: { col: 5, row: 4 } }),
			destination(5),
		)
		edges.push(
			arrow('t4', 't5', 0.22, 0.2),
			arrow('t5', 't6', 0.45, 0.45),
			arrow('t6', 'destination', 0.45, 0.42),
		)
	}

	return { className: 'max-w-[24rem]', nodes, edges }
}

/** The tickets of the worked example, by kind. */
export const KINDS = ['Grilling', 'Research', 'Prototype', 'Grilling', 'Task']
