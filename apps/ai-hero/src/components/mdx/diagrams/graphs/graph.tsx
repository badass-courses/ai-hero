'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { Centred } from '../centred'
import { GRAPH_INK } from './ink'

export type GraphSide = 'top' | 'right' | 'bottom' | 'left'

type Spot = 'start' | 'center' | 'end' | 'stretch'

/**
 * Where a node sits on the drawing's 12-column grid: 1-based column and row,
 * how many of each it spans, and how it sits inside that area. A node spanning
 * rows lets a neighbour start halfway down it, which is how the drawings
 * offset their boxes.
 */
export type GraphPlace = {
	col: number
	row: number
	span?: number
	rows?: number
	/** Across its columns: `stretch` (the default) for a box that fills
	    them, `start`, `center` or `end` for one sized by its content. */
	justify?: Spot
	align?: Spot
}

export type GraphNode = {
	id: string
	/** What a screen reader calls it in the list of arrows. */
	name?: string
	content: React.ReactNode
	wide: GraphPlace
	/** Its place on a phone, when the wide one leaves too little room. */
	narrow?: GraphPlace
	/** Greyed out, as Matt greys a ticket that is still blocked. */
	dim?: boolean
}

/**
 * One end of an arrow: a side of a node, or of a part inside it marked
 * `data-graph-part` (a note's title, a module's interface band), `at` that
 * fraction along the side. An empty `part` is the whole node again: a phone
 * override cannot unset it with `undefined`, which does not survive the trip
 * from the server. `inset` pulls the point into the node, for an
 * arrow that reaches inside a module. An end naming a seam lands on the
 * seam's left end, coming in from `side`.
 */
export type GraphEnd = {
	id: string
	side: GraphSide
	at?: number
	part?: string
	inset?: number
}

export type GraphEdge = {
	from: GraphEnd
	to: GraphEnd
	/** Other ends for the phone layout, where the nodes have moved. */
	narrow?: { from?: Partial<GraphEnd>; to?: Partial<GraphEnd> }
	/** `straight` for Matt's ruled arrows, `curve` for his swept ones,
	    `elbow` for a tree's down-and-across connector. */
	shape?: 'straight' | 'curve' | 'elbow'
	/** `note` is a red pointer from a label to what it names. */
	ink?: 'line' | 'note'
	dashed?: boolean
	/** A tree connector has no arrowhead. */
	headless?: boolean
	/** Runs level from where it leaves, as Matt's pointers from a label to
	    the box beside it do, whatever the height of the box. */
	level?: boolean
}

/** A blue dashed seam drawn across arrows: across one, square to it at its
    middle; across several, through all of their middles and on past them. */
export type GraphSeam = { id: string; crosses: readonly string[] }

export type GraphDiagram = {
	title?: string
	nodes: readonly GraphNode[]
	edges: readonly GraphEdge[]
	seams?: readonly GraphSeam[]
	/** The grid's width and spacing, which set how big the drawing reads. */
	className?: string
}

/** The key an edge is known by, in seams and in `data-edge`. */
export const edgeKey = (edge: GraphEdge) => `${edge.from.id}-${edge.to.id}`

/**
 * One of Matt's box-and-arrow drawings, drawn from data. The nodes are real
 * HTML on a grid that mirrors where they sit in his drawing, so their text
 * wraps instead of shrinking on a phone; the arrows and seams are measured
 * from where the nodes land and redrawn whenever the figure resizes.
 */
export function Graph({ diagram }: { diagram: GraphDiagram }) {
	const gridRef = React.useRef<HTMLDivElement>(null)
	const [drawn, setDrawn] = React.useState<Drawn>({ edges: [], seams: [] })
	const markerId = React.useId()

	React.useLayoutEffect(() => {
		const grid = gridRef.current
		if (!grid) return

		const draw = () => {
			const origin = grid.getBoundingClientRect()
			const narrow =
				getComputedStyle(grid).getPropertyValue('--graph-layout').trim() ===
				'narrow'
			const boxOf = (end: GraphEnd): Box | null => {
				const node = grid.querySelector<HTMLElement>(`[data-node="${end.id}"]`)
				const el = end.part
					? node?.querySelector(`[data-graph-part="${end.part}"]`)
					: node?.firstElementChild
				if (!el) return null
				const r = el.getBoundingClientRect()
				return {
					left: r.left - origin.left,
					top: r.top - origin.top,
					right: r.right - origin.left,
					bottom: r.bottom - origin.top,
				}
			}

			const seamIds = new Set(diagram.seams?.map((seam) => seam.id))
			const curves = new Map<string, Curve>()
			const seams = new Map<string, [Point, Point]>()

			const curveOf = (edge: GraphEdge): Curve | null => {
				const from = { ...edge.from, ...(narrow ? edge.narrow?.from : {}) }
				const to = { ...edge.to, ...(narrow ? edge.narrow?.to : {}) }
				const fromBox = boxOf(from)
				if (!fromBox) return null
				const a = anchor(fromBox, from)
				const seam = seams.get(to.id)
				const toBox = seam ? null : boxOf(to)
				if (!seam && !toBox) return null
				const target = seam ? seam[0] : anchor(toBox!, to)
				const b = edge.level ? { x: target.x, y: a.y } : target
				return shape(a, b, from.side, to.side, edge.shape ?? 'straight')
			}

			// Arrows between nodes first, then the seams across them, then
			// the pointers that land on a seam.
			for (const edge of diagram.edges) {
				if (seamIds.has(edge.to.id)) continue
				const curve = curveOf(edge)
				if (curve) curves.set(edgeKey(edge), curve)
			}
			for (const seam of diagram.seams ?? []) {
				const line = seamLine(
					seam.crosses.flatMap((key) => curves.get(key) ?? []),
				)
				if (line) seams.set(seam.id, line)
			}
			for (const edge of diagram.edges) {
				if (!seamIds.has(edge.to.id)) continue
				const curve = curveOf(edge)
				if (curve) curves.set(edgeKey(edge), curve)
			}

			setDrawn({
				edges: diagram.edges.flatMap((edge) => {
					const curve = curves.get(edgeKey(edge))
					return curve ? [{ edge, d: curve.d }] : []
				}),
				seams: [...seams].map(([id, [a, b]]) => ({
					id,
					d: `M${a.x},${a.y} L${b.x},${b.y}`,
				})),
			})
		}

		draw()
		const observer = new ResizeObserver(draw)
		observer.observe(grid)
		return () => observer.disconnect()
	}, [diagram])

	const nameOf = new Map(diagram.nodes.map((node) => [node.id, node.name]))
	const told = diagram.edges.filter(
		(edge) =>
			(edge.ink ?? 'line') === 'line' &&
			nameOf.get(edge.from.id) &&
			nameOf.get(edge.to.id),
	)

	return (
		<figure className="not-prose @container my-8">
			{diagram.title ? (
				<figcaption
					className={cn(TYPE.subhead, 'mb-7 text-center text-balance')}
				>
					{diagram.title}
				</figcaption>
			) : null}
			<Centred>
				<div
					ref={gridRef}
					// `--graph-layout` tells the arrows which placement the grid is in.
					className={cn(
						'relative mx-auto grid grid-cols-12 gap-x-3 gap-y-10 [--graph-layout:narrow] @2xl:gap-x-4 @2xl:gap-y-12 @2xl:[--graph-layout:wide]',
						diagram.className,
					)}
				>
					{/* Over the nodes, so a pointer can reach inside a module. */}
					<svg
						aria-hidden
						className="pointer-events-none absolute inset-0 z-10 size-full overflow-visible"
					>
						<defs>
							{(['line', 'note'] as const).map((ink) => (
								<marker
									key={ink}
									id={`${markerId}-${ink}`}
									viewBox="0 0 10 10"
									refX="9"
									refY="5"
									markerWidth="9"
									markerHeight="9"
									markerUnits="userSpaceOnUse"
									orient="auto"
								>
									<path d="M1 0.5 L9 5 L1 9.5 Z" fill={GRAPH_INK[ink]} />
								</marker>
							))}
						</defs>
						{drawn.seams.map((seam) => (
							<path
								key={seam.id}
								data-seam={seam.id}
								d={seam.d}
								fill="none"
								stroke={GRAPH_INK.seam}
								strokeWidth="2"
								strokeDasharray="7 6"
								strokeLinecap="round"
							/>
						))}
						{drawn.edges.map(({ edge, d }) => {
							const ink = edge.ink ?? 'line'
							return (
								<path
									key={edgeKey(edge)}
									data-edge={edgeKey(edge)}
									d={d}
									fill="none"
									stroke={GRAPH_INK[ink]}
									strokeWidth={ink === 'note' ? 2 : 1.5}
									strokeDasharray={edge.dashed ? '6 5' : undefined}
									strokeLinecap={edge.dashed ? 'butt' : 'round'}
									markerEnd={
										edge.headless ? undefined : `url(#${markerId}-${ink})`
									}
								/>
							)
						})}
					</svg>
					{diagram.nodes.map((node) => (
						<div
							key={node.id}
							data-node={node.id}
							data-dim={node.dim || undefined}
							className="relative [grid-column:var(--n-col)/span_var(--n-span)] [grid-row:var(--n-row)/span_var(--n-rows)] flex [align-self:var(--n-align)] [justify-self:var(--n-justify)] transition-opacity data-dim:opacity-35 @2xl:[grid-column:var(--w-col)/span_var(--w-span)] @2xl:[grid-row:var(--w-row)/span_var(--w-rows)] @2xl:[align-self:var(--w-align)] @2xl:[justify-self:var(--w-justify)]"
							style={placement(node)}
						>
							{node.content}
						</div>
					))}
				</div>
			</Centred>
			{told.length > 0 ? (
				<ul className="sr-only">
					{told.map((edge) => (
						<li key={edgeKey(edge)}>
							{nameOf.get(edge.from.id)} leads to {nameOf.get(edge.to.id)}
						</li>
					))}
				</ul>
			) : null}
		</figure>
	)
}

/** Both of a node's places as custom properties, for the grid to pick
    between by the figure's width. */
function placement({ wide, narrow = wide }: GraphNode) {
	const vars = (prefix: 'w' | 'n', place: GraphPlace) => ({
		[`--${prefix}-col`]: place.col,
		[`--${prefix}-row`]: place.row,
		[`--${prefix}-span`]: place.span ?? 12 - place.col + 1,
		[`--${prefix}-rows`]: place.rows ?? 1,
		[`--${prefix}-justify`]: place.justify ?? 'stretch',
		[`--${prefix}-align`]: place.align ?? 'start',
	})
	return { ...vars('w', wide), ...vars('n', narrow) } as React.CSSProperties
}

type Box = { left: number; top: number; right: number; bottom: number }
type Point = { x: number; y: number }
type Curve = { d: string; mid: Point; tangent: Point }
type Drawn = {
	edges: { edge: GraphEdge; d: string }[]
	seams: { id: string; d: string }[]
}

/** The gap left between an arrow and the node it touches. */
const CLEARANCE = 6

function anchor(box: Box, { side, at = 0.5, inset = 0 }: GraphEnd): Point {
	const x = box.left + (box.right - box.left) * at
	const y = box.top + (box.bottom - box.top) * at
	switch (side) {
		case 'top':
			return { x, y: box.top - CLEARANCE + inset }
		case 'bottom':
			return { x, y: box.bottom + CLEARANCE - inset }
		case 'left':
			return { x: box.left - CLEARANCE + inset, y }
		case 'right':
			return { x: box.right + CLEARANCE - inset, y }
	}
}

const NORMAL: Record<GraphSide, Point> = {
	top: { x: 0, y: -1 },
	bottom: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
}

/** The arrow's path, with its middle and direction there for a seam to
    cross. A curve leaves and arrives square to each side. */
function shape(
	a: Point,
	b: Point,
	exit: GraphSide,
	enter: GraphSide,
	kind: 'straight' | 'curve' | 'elbow',
): Curve {
	if (kind === 'elbow') {
		return {
			d: `M${a.x},${a.y} V${b.y} H${b.x}`,
			mid: { x: a.x, y: (a.y + b.y) / 2 },
			tangent: { x: 0, y: 1 },
		}
	}
	if (kind === 'straight') {
		return {
			d: `M${a.x},${a.y} L${b.x},${b.y}`,
			mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
			tangent: { x: b.x - a.x, y: b.y - a.y },
		}
	}
	const reach = Math.min(
		110,
		Math.max(24, Math.hypot(b.x - a.x, b.y - a.y) * 0.45),
	)
	const c1 = {
		x: a.x + NORMAL[exit].x * reach,
		y: a.y + NORMAL[exit].y * reach,
	}
	const c2 = {
		x: b.x + NORMAL[enter].x * reach,
		y: b.y + NORMAL[enter].y * reach,
	}
	return {
		d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`,
		mid: {
			x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8,
			y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8,
		},
		tangent: { x: b.x + c2.x - c1.x - a.x, y: b.y + c2.y - c1.y - a.y },
	}
}

/** How far a seam runs past the arrows it crosses. */
const SEAM_REACH = 36

/** A seam's two ends, left one first. */
function seamLine(curves: Curve[]): [Point, Point] | null {
	const first = curves[0]
	if (!first) return null
	let a: Point
	let b: Point
	if (curves.length === 1) {
		const t = first.tangent
		const length = Math.hypot(t.x, t.y) || 1
		const n = { x: -t.y / length, y: t.x / length }
		a = { x: first.mid.x + n.x * SEAM_REACH, y: first.mid.y + n.y * SEAM_REACH }
		b = { x: first.mid.x - n.x * SEAM_REACH, y: first.mid.y - n.y * SEAM_REACH }
	} else {
		const mids = curves.map((curve) => curve.mid).sort((p, q) => p.x - q.x)
		const start = mids[0]!
		const end = mids[mids.length - 1]!
		const length = Math.hypot(end.x - start.x, end.y - start.y) || 1
		const u = { x: (end.x - start.x) / length, y: (end.y - start.y) / length }
		a = {
			x: start.x - u.x * SEAM_REACH * 1.5,
			y: start.y - u.y * SEAM_REACH * 1.5,
		}
		b = { x: end.x + u.x * SEAM_REACH * 1.5, y: end.y + u.y * SEAM_REACH * 1.5 }
	}
	return a.x <= b.x ? [a, b] : [b, a]
}
