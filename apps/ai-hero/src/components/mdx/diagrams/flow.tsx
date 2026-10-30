'use client'

import * as React from 'react'
import { BADGE_OUTLINE, TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { Centred } from './centred'
import { routeArrow, type Box, type Point } from './flow-route'
import { FLOW_ROLES, type FlowRole } from './roles'

export { FLOW_ROLES, type FlowRole } from './roles'

export type FlowSide = 'top' | 'right' | 'bottom' | 'left'

/**
 * Where a step sits on the drawing's 12-column grid: 1-based column and row,
 * and the columns its text may wrap within (4 by default, a third of the
 * width, which is how wide Matt's steps run).
 */
export type FlowPlace = { col: number; row: number; span?: number }

/** A step. `wide` places it where it sits in Matt's drawing; `narrow`, when
    given, is its place on a phone, where a third of the width is too little
    to wrap in. */
export type FlowNode = {
	id: string
	/** One badge per role. Repeating a role draws that many of it, as in
	    "a runner per ticket". */
	roles: readonly FlowRole[]
	/** Trails the badges with an ellipsis: "and as many more as needed". */
	more?: boolean
	/** A command Matt wrote beside the steps rather than a step: no badge,
	    and set in mono, a line per command. */
	code?: boolean
	text: string
	wide: FlowPlace
	narrow?: FlowPlace
}

/**
 * An arrow, and the sides of the two steps it leaves and enters by, read off
 * the original. Sides attach to a step's badges, as Matt's do: `left` and
 * `right` at the badge row's ends, `top` above the badges, `bottom` under the
 * step's text.
 */
export type FlowEdge = FlowEdgeSides & {
	from: string
	to: string
	/** Other sides for the phone layout, where the steps have moved. */
	narrow?: Partial<FlowEdgeSides>
}

type FlowEdgeSides = {
	exit: FlowSide
	enter: FlowSide
	/** Leaves a `left` or `right` side level with the step's text instead of
	    its badges, where Matt starts an arrow beside the words. */
	exitBesideText?: boolean
}

export type FlowDiagram = {
	title: string
	description?: string
	nodes: readonly FlowNode[]
	edges: readonly FlowEdge[]
}

/**
 * One of Matt's node-and-arrow workflow diagrams, drawn from data so it stays
 * sharp and readable at any width. The steps are real text on a grid that
 * mirrors the original's composition, so they wrap instead of shrinking; the
 * arrows are measured from where the steps land and redrawn whenever the
 * figure resizes.
 */
export function Flow({
	diagram,
	focus,
}: {
	diagram: FlowDiagram
	/** The steps Matt was pointing at in this frame of the video. The rest of
	    the drawing steps back, and so does any arrow that touches none of
	    them. */
	focus?: readonly string[]
}) {
	const gridRef = React.useRef<HTMLDivElement>(null)
	const [paths, setPaths] = React.useState<
		{ d: string; key: string; from: string; to: string }[]
	>([])
	// The step under the pointer: it and the steps it connects to stay lit,
	// and the rest of the drawing steps back, the way the Software Factory
	// map reads on hover.
	const [hovered, setHovered] = React.useState<string | null>(null)
	const lit = React.useMemo(() => {
		if (hovered === null) return focus
		return [
			hovered,
			...diagram.edges.flatMap((edge) =>
				edge.from === hovered
					? [edge.to]
					: edge.to === hovered
						? [edge.from]
						: [],
			),
		]
	}, [hovered, focus, diagram])
	const isDim = (id: string) => lit !== undefined && !lit.includes(id)
	/** Hovering lights only the hovered step's own arrows; a frame's focus
	    keeps any arrow that touches a step in it. */
	const isDimEdge = (from: string, to: string) =>
		hovered === null
			? isDim(from) && isDim(to)
			: from !== hovered && to !== hovered
	const markerId = React.useId()

	React.useLayoutEffect(() => {
		const grid = gridRef.current
		if (!grid) return

		const draw = () => {
			const origin = grid.getBoundingClientRect()
			const relative = (r: DOMRect): Box => ({
				left: r.left - origin.left,
				top: r.top - origin.top,
				right: r.right - origin.left,
				bottom: r.bottom - origin.top,
			})
			const steps = new Map<string, Step>()
			// Every badge row and line of words, for the arrows to keep clear of.
			const labels: Box[] = []
			const range = document.createRange()
			for (const el of grid.querySelectorAll<HTMLElement>('[data-flow-node]')) {
				const text = el.querySelector('[data-flow-text]')
				if (text) {
					range.selectNodeContents(text)
					for (const line of range.getClientRects()) {
						if (line.width > 0) labels.push(relative(line))
					}
				}
				const badges = el.querySelector('[data-flow-badges]')
				if (!badges) continue
				labels.push(relative(badges.getBoundingClientRect()))
				steps.set(el.dataset.flowNode!, {
					node: relative(el.getBoundingClientRect()),
					badges: relative(badges.getBoundingClientRect()),
				})
			}
			// Arrows stay within the figure's gutter, so a phone never clips one.
			const bounds: Box = {
				left: -8,
				top: -8,
				right: origin.width + 8,
				bottom: origin.height + 24,
			}
			const narrow =
				getComputedStyle(grid).getPropertyValue('--flow-layout').trim() ===
				'narrow'
			setPaths(
				diagram.edges.flatMap((edge) => {
					const from = steps.get(edge.from)
					const to = steps.get(edge.to)
					if (!from || !to) return []
					const sides = narrow ? { ...edge, ...edge.narrow } : edge
					return [
						{
							key: `${edge.from}-${edge.to}`,
							d: route(from, to, sides, labels, bounds),
							from: edge.from,
							to: edge.to,
						},
					]
				}),
			)
		}

		draw()
		const observer = new ResizeObserver(draw)
		observer.observe(grid)
		return () => observer.disconnect()
	}, [diagram])

	const textOf = new Map(diagram.nodes.map((node) => [node.id, node.text]))

	return (
		<figure className="not-prose @container my-8 cursor-default select-none">
			<figcaption className="mb-7 text-center text-balance">
				<span className={cn(TYPE.subhead, 'block')}>{diagram.title}</span>
				{diagram.description ? (
					<span className={cn(TYPE.meta, 'text-muted-foreground mt-1 block')}>
						{diagram.description}
					</span>
				) : null}
			</figcaption>
			<Centred>
				<div
					ref={gridRef}
					// `--flow-layout` tells the arrows which placement the grid is in.
					className="relative grid grid-cols-12 gap-y-8 [--flow-layout:narrow] @2xl:gap-y-10 @2xl:[--flow-layout:wide]"
				>
					<svg
						aria-hidden
						// The house ink (the Software Factory map's): the foreground mixed
						// into the page, opaque, so an arrow running under its head shows
						// no brighter patch.
						className="pointer-events-none absolute inset-0 size-full overflow-visible text-[color-mix(in_oklab,var(--foreground)_58%,var(--background))]"
					>
						<defs>
							<marker
								id={markerId}
								viewBox="0 0 8 9"
								refX="8"
								refY="4.5"
								markerWidth="8"
								markerHeight="9"
								markerUnits="userSpaceOnUse"
								orient="auto"
							>
								<path d="M8 4.5 L0 0 L0 9 Z" fill="currentColor" />
							</marker>
						</defs>
						{paths.map((path) => (
							<path
								className="motion-safe:transition-opacity motion-safe:duration-300"
								key={path.key}
								data-edge={path.key}
								d={path.d}
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								markerEnd={`url(#${markerId})`}
								opacity={isDimEdge(path.from, path.to) ? 0.3 : 1}
							/>
						))}
					</svg>
					{diagram.nodes.map((node) => (
						<div
							key={node.id}
							data-flow-node={node.id}
							data-node={node.id}
							className="relative [grid-column:var(--n-col)/span_var(--n-span)] [grid-row:var(--n-row)] self-start pr-5 data-dim:opacity-40 motion-safe:transition-opacity motion-safe:duration-300 @2xl:[grid-column:var(--w-col)/span_var(--w-span)] @2xl:[grid-row:var(--w-row)]"
							style={placement(node)}
							data-dim={isDim(node.id) || undefined}
							onPointerEnter={(event) => {
								if (event.pointerType === 'mouse') setHovered(node.id)
							}}
							onPointerLeave={() => setHovered(null)}
						>
							{node.code ? null : (
								<span
									data-flow-badges
									className="mb-1.5 inline-flex items-center gap-1"
								>
									{node.roles.map((role, i) => (
										<span
											key={i}
											className={cn(
												TYPE.badge,
												BADGE_OUTLINE,
												'bg-background px-[5px] py-[4px] whitespace-nowrap',
											)}
											style={
												{
													'--role': FLOW_ROLES[role].hue,
													borderColor:
														'color-mix(in oklab, var(--role) 80%, var(--background))',
													color:
														'color-mix(in oklab, var(--role) 72%, var(--foreground))',
												} as React.CSSProperties
											}
										>
											{FLOW_ROLES[role].label}
										</span>
									))}
									{node.more ? (
										<span
											aria-label="and more"
											className={cn(TYPE.meta, 'font-bold')}
										>
											…
										</span>
									) : null}
								</span>
							)}
							<span
								data-flow-text
								className={cn(
									'block',
									node.code
										? cn(TYPE.metaMono, 'whitespace-pre-line')
										: cn(TYPE.meta, 'font-bold text-pretty'),
								)}
							>
								{node.text}
							</span>
						</div>
					))}
				</div>
			</Centred>
			<ul className="sr-only">
				{/* An arrow into a blank step (one Matt had yet to fill in) says
				    nothing a listener can use. */}
				{diagram.edges
					.filter((edge) => textOf.get(edge.from) && textOf.get(edge.to))
					.map((edge) => (
						<li key={`${edge.from}-${edge.to}`}>
							{textOf.get(edge.from)} leads to {textOf.get(edge.to)}
						</li>
					))}
			</ul>
		</figure>
	)
}

/** Both of a step's places as custom properties, for the grid to pick
    between by the figure's width. */
function placement({ wide, narrow = wide }: FlowNode) {
	return {
		'--w-col': wide.col,
		'--w-row': wide.row,
		'--w-span': wide.span ?? 4,
		'--n-col': narrow.col,
		'--n-row': narrow.row,
		'--n-span': narrow.span ?? 4,
	} as React.CSSProperties
}

type Step = { node: Box; badges: Box }

/** The gap an arrow leaves where it starts, and the smaller one between
    an arrowhead's tip and the step it points at. */
const CLEARANCE = 5
const TIP_GAP = 4

/** Where an arrow touches a step. An arrow leaving by the bottom sits right of
    one arriving there, so a step that is both a target and a source keeps the
    two apart. */
function anchor(
	{ node, badges }: Step,
	side: FlowSide,
	role: 'exit' | 'enter',
	besideText = false,
): Point {
	const gap = role === 'enter' ? TIP_GAP : CLEARANCE
	const midY = besideText
		? (badges.bottom + node.bottom) / 2
		: (badges.top + badges.bottom) / 2
	switch (side) {
		case 'top':
			return {
				x: Math.min(badges.left + 24, badges.right),
				y: badges.top - gap,
			}
		case 'bottom':
			return {
				x: badges.left + (role === 'exit' ? 30 : 8),
				y: node.bottom + gap,
			}
		case 'left':
			return { x: badges.left - gap, y: midY }
		case 'right':
			return { x: badges.right + gap, y: midY }
	}
}

const NORMAL: Record<FlowSide, Point> = {
	top: { x: 0, y: -1 },
	bottom: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
}

/** An arrow that leaves and arrives square to each side, so a chain down one
    column bows out to the left the way Matt draws it, and goes around any
    step in its way. */
function route(
	from: Step,
	to: Step,
	edge: FlowEdgeSides,
	labels: readonly Box[],
	bounds: Box,
) {
	const a = anchor(from, edge.exit, 'exit', edge.exitBesideText)
	const b = anchor(to, edge.enter, 'enter')
	return routeArrow(a, NORMAL[edge.exit], b, NORMAL[edge.enter], labels, bounds)
}
