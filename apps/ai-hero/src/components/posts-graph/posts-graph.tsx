'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { PostsGraph } from '@/lib/posts-graph'
import dynamic from 'next/dynamic'

import type { ForceGraphMethods } from 'react-force-graph-2d'

// react-force-graph touches `window` on import — client-only.
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
	ssr: false,
})

type GraphNode = PostsGraph['nodes'][number] & {
	neighbors?: Set<string>
	degree?: number
	// runtime sim coords added by d3-force
	x?: number
	y?: number
}
type GraphLink = {
	source: string | GraphNode
	target: string | GraphNode
	weight: number
}

function nodeId(end: string | GraphNode): string {
	return typeof end === 'object' ? end.id : end
}

type RGB = [number, number, number]

// Reusable 1×1 canvas to rasterize ANY CSS color (hsl/oklch/lab/var) down to
// concrete sRGB bytes. getComputedStyle().color is unreliable here — some
// browsers return the color in its authored space (e.g. lab()), so we paint a
// pixel and read it back, which is always sRGB.
let probeCtx: CanvasRenderingContext2D | null = null

/** Resolve a CSS variable (any color format) to [r,g,b] via the browser. */
function readTokenRgb(el: HTMLElement, name: string, fallback: RGB): RGB {
	if (typeof document === 'undefined') return fallback
	const raw = getComputedStyle(el).getPropertyValue(name).trim()
	if (!raw) return fallback
	if (!probeCtx) {
		const c = document.createElement('canvas')
		c.width = c.height = 1
		probeCtx = c.getContext('2d', { willReadFrequently: true })
	}
	if (!probeCtx) return fallback
	probeCtx.clearRect(0, 0, 1, 1)
	probeCtx.fillStyle = rgbStr(fallback) // sentinel if `raw` is unparseable
	probeCtx.fillStyle = raw
	probeCtx.fillRect(0, 0, 1, 1)
	const d = probeCtx.getImageData(0, 0, 1, 1).data
	return [d[0]!, d[1]!, d[2]!]
}

/** Opaque gray: mix from background (t=0) toward foreground (t=1). */
function mixRgb(bg: RGB, fg: RGB, t: number): string {
	const c = Math.max(0, Math.min(1, t))
	const r = Math.round(bg[0] + (fg[0] - bg[0]) * c)
	const g = Math.round(bg[1] + (fg[1] - bg[1]) * c)
	const b = Math.round(bg[2] + (fg[2] - bg[2]) * c)
	return `rgb(${r}, ${g}, ${b})`
}

const rgbStr = (c: RGB) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`
const rgbaStr = (c: RGB, a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`

const DIM_ALPHA = 0.12
const EASE = 0.18 // per-frame approach factor for hover transitions
const APPEAR_MS = 700

/** Resting node radius before center bump / appear scaling. */
const baseRadius = (node: GraphNode) =>
	(1 + (node.degree ?? 0) * 0.6) * 0.8 + 1.5

export function PostsGraph({
	graph,
	enableZoom = false,
	fitOnLoad = false,
	showHoverCard = false,
	matchIds = null,
}: {
	graph: PostsGraph
	/** allow wheel/pinch zoom interaction */
	enableZoom?: boolean
	/** auto zoom-to-fit the whole graph once it settles */
	fitOnLoad?: boolean
	/** rich preview card on node hover (global graph only) */
	showHoverCard?: boolean
	/**
	 * When set, the graph is filtered to these node ids (driven by the current
	 * Typesense search results). `null`/`undefined` = no filter (show everything).
	 */
	matchIds?: string[] | null
}) {
	const router = useRouter()
	const containerRef = React.useRef<HTMLDivElement>(null)
	const fgRef = React.useRef<ForceGraphMethods<GraphNode, GraphLink>>(undefined)
	const [size, setSize] = React.useState({ width: 0, height: 0 })
	const [hovered, setHovered] = React.useState<GraphNode | null>(null)
	const [colors, setColors] = React.useState<{
		fg: RGB
		bg: RGB
		link: RGB
		highlight: RGB
	}>({
		fg: [136, 136, 136],
		bg: [0, 0, 0],
		link: [136, 136, 136],
		highlight: [136, 136, 136],
	})

	// Live refs the animation loop reads without restarting on every render.
	const hoverRef = React.useRef<GraphNode | null>(null)
	const alphaRef = React.useRef<Map<string, number>>(new Map())
	const appearStartRef = React.useRef<number>(0)
	const rafRef = React.useRef<number | null>(null)
	const cardRef = React.useRef<HTMLDivElement>(null)
	const didFitRef = React.useRef(false)

	const centerId = graph.centerId ?? null

	// Build node/link objects + adjacency. When `matchIds` is set (driven by the
	// current Typesense search), the graph is filtered to those nodes; edges are
	// kept only between surviving nodes.
	const matchKey = matchIds ? matchIds.join(',') : null
	const data = React.useMemo(() => {
		const allow = matchIds ? new Set(matchIds) : null
		const byId = new Map<string, GraphNode>()
		const nodes: GraphNode[] = graph.nodes
			.filter((n) => !allow || allow.has(n.id))
			.map((n) => {
				const node: GraphNode = { ...n, neighbors: new Set(), degree: 0 }
				byId.set(n.id, node)
				return node
			})
		const links: GraphLink[] = []
		for (const e of graph.edges) {
			const s = byId.get(e.source)
			const t = byId.get(e.target)
			if (!s || !t) continue
			s.neighbors!.add(t.id)
			t.neighbors!.add(s.id)
			s.degree! += 1
			t.degree! += 1
			links.push({ source: e.source, target: e.target, weight: e.weight })
		}
		return { nodes, links }
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [graph, matchKey])

	// Resolve theme tokens (re-run on theme change via the `class` mutation).
	React.useEffect(() => {
		const el = containerRef.current
		if (!el) return
		const resolve = () =>
			setColors({
				fg: readTokenRgb(el, '--foreground', [136, 136, 136]),
				bg: readTokenRgb(el, '--background', [0, 0, 0]),
				link: readTokenRgb(el, '--muted-foreground', [136, 136, 136]),
				highlight: readTokenRgb(el, '--primary', [136, 136, 136]),
			})
		resolve()
		const observer = new MutationObserver(resolve)
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class'],
		})
		return () => observer.disconnect()
	}, [])

	// Track container size for a responsive canvas.
	React.useEffect(() => {
		const el = containerRef.current
		if (!el) return
		const update = () =>
			setSize({ width: el.clientWidth, height: el.clientHeight })
		update()
		const ro = new ResizeObserver(update)
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	// Tune the force simulation + kick off the settle-in fade.
	React.useEffect(() => {
		const fg = fgRef.current
		if (!fg) return
		fg.d3Force('charge')?.strength(-130) // repelForce
		fg.d3Force('link')?.distance(42) // linkDistance
		appearStartRef.current =
			typeof performance !== 'undefined' ? performance.now() : 0
		alphaRef.current = new Map(data.nodes.map((n) => [n.id, 1]))
		didFitRef.current = false
	}, [data])

	// Continuous animation loop: eases hover dimming, drives the center pulse,
	// and keeps the canvas repainting while there's something moving.
	React.useEffect(() => {
		const tick = () => {
			const fg = fgRef.current
			const now = typeof performance !== 'undefined' ? performance.now() : 0
			const hov = hoverRef.current
			const alphas = alphaRef.current

			let animating = false

			// ease each node's alpha toward its hover target
			for (const node of data.nodes) {
				const target = !hov
					? 1
					: node.id === hov.id || hov.neighbors?.has(node.id)
						? 1
						: DIM_ALPHA
				const current = alphas.get(node.id) ?? 1
				const next = current + (target - current) * EASE
				alphas.set(node.id, next)
				if (Math.abs(target - next) > 0.005) animating = true
			}

			const appearing = now - appearStartRef.current < APPEAR_MS

			// Repaint only while something is actually moving — idle = no work.
			// (Directional particles on hover keep their own loop alive.)
			if ((animating || appearing) && fg) {
				// @ts-expect-error refresh() repaints the canvas (runtime method)
				fg.refresh?.()
			}

			// Keep the hover card pinned to its node (survives drift / pan / zoom).
			if (
				showHoverCard &&
				hov &&
				fg &&
				cardRef.current &&
				hov.x != null &&
				hov.y != null
			) {
				const { x, y } = fg.graph2ScreenCoords(hov.x, hov.y)
				cardRef.current.style.transform = `translate(${x}px, ${y}px)`
			}
			rafRef.current = requestAnimationFrame(tick)
		}
		rafRef.current = requestAnimationFrame(tick)
		return () => {
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
		}
	}, [data, centerId, showHoverCard])

	const appearProgress = () => {
		if (typeof performance === 'undefined') return 1
		return Math.min(1, (performance.now() - appearStartRef.current) / APPEAR_MS)
	}

	const hoveredId = hovered?.id ?? null

	// A link is "lit" only when it connects to the hovered node.
	const linkLit = (l: GraphLink) => {
		if (!hoveredId) return false
		return nodeId(l.source) === hoveredId || nodeId(l.target) === hoveredId
	}

	return (
		<div ref={containerRef} className="bg-background relative h-full w-full">
			{size.width > 0 && (
				<ForceGraph2D
					ref={fgRef as any}
					width={size.width}
					height={size.height}
					graphData={data}
					backgroundColor="rgba(0,0,0,0)"
					nodeRelSize={4}
					nodeVal={(n) => 1 + ((n as GraphNode).degree ?? 0) * 0.6}
					cooldownTicks={140}
					d3VelocityDecay={0.3}
					enableNodeDrag
					enableZoomInteraction={enableZoom}
					// Frame the whole graph once on load, then keep the render loop
					// alive after the sim settles so pointer hit-testing (hover) keeps
					// working — without reheating the physics.
					onEngineStop={() => {
						const fg = fgRef.current
						if (!fg) return
						if (fitOnLoad && !didFitRef.current) {
							didFitRef.current = true
							fg.zoomToFit(450, 28)
						}
						fg.resumeAnimation?.()
					}}
					// links — faint at rest; the hovered node's links brighten (foreground)
					linkColor={(l) => {
						const a = appearProgress()
						if (linkLit(l as GraphLink)) return rgbaStr(colors.fg, 0.8)
						const dim = hoveredId ? 0.06 : 0.16
						return rgbaStr(colors.link, dim * a)
					}}
					linkWidth={(l) => {
						const link = l as GraphLink
						return (0.5 + link.weight * 0.8) * (linkLit(link) ? 1.8 : 1)
					}}
					linkDirectionalParticles={(l) => (linkLit(l as GraphLink) ? 2 : 0)}
					linkDirectionalParticleWidth={1.8}
					linkDirectionalParticleSpeed={0.006}
					linkDirectionalParticleColor={() => rgbStr(colors.fg)}
					// interaction
					onNodeClick={(n) => {
						const node = n as GraphNode
						if (node.slug) router.push(`/${node.slug}`)
					}}
					onNodeHover={(n) => {
						hoverRef.current = (n as GraphNode) ?? null
						setHovered((n as GraphNode) ?? null)
						if (containerRef.current) {
							containerRef.current.style.cursor = n ? 'pointer' : 'default'
						}
					}}
					nodeCanvasObject={(n, ctx, globalScale) => {
						const node = n as GraphNode
						const isCenter = node.id === centerId
						const isHovered = node.id === hoveredId
						const appear = appearProgress()
						const eased = alphaRef.current.get(node.id) ?? 1

						const baseR = baseRadius(node)
						const r = (isCenter ? baseR + 2 : baseR) * (0.6 + 0.4 * appear)

						// Filled dots always — a single OPAQUE disc (no overlay). Active
						// discs (the current node + the hovered node) are highlighted with
						// full foreground; everything else is a dimmer gray shade mixed in
						// code from background→foreground. Opaque = links never show through;
						// the fade-in grows the tone up from the background so it stays opaque.
						const highlighted = isCenter || isHovered
						const roleT = highlighted ? 1 : 0.5
						const activeT = DIM_ALPHA + (roleT - DIM_ALPHA) * eased
						ctx.beginPath()
						ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI)
						ctx.fillStyle = mixRgb(colors.bg, colors.fg, activeT * appear)
						ctx.globalAlpha = 1
						ctx.fill()
					}}
					// Enlarge the hover/click hit target so small dots are easy to grab.
					nodePointerAreaPaint={(n, color, ctx) => {
						const node = n as GraphNode
						const baseR = baseRadius(node)
						const r = (node.id === centerId ? baseR + 2 : baseR) + 5
						ctx.fillStyle = color
						ctx.beginPath()
						ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI)
						ctx.fill()
					}}
					// Labels in a post-frame pass so text sits on top of every node + link.
					onRenderFramePost={(ctx, globalScale) => {
						const appear = appearProgress()
						ctx.textAlign = 'center'
						ctx.textBaseline = 'top'
						for (const node of data.nodes) {
							const isCenter = node.id === centerId
							const isHovered = node.id === hoveredId
							const show =
								isHovered || (isCenter && !hoveredId) || globalScale > 2.4
							if (!show || !node.title || node.x == null || node.y == null)
								continue
							const eased = alphaRef.current.get(node.id) ?? 1
							const baseR = baseRadius(node)
							const r = (isCenter ? baseR + 2 : baseR) * (0.6 + 0.4 * appear)
							const fontSize = Math.max(10 / globalScale, 2.5)
							ctx.font = `${fontSize}px sans-serif`
							ctx.fillStyle = rgbStr(colors.fg)
							ctx.globalAlpha = eased * appear
							ctx.fillText(node.title, node.x, node.y + r + 1.5)
						}
						ctx.globalAlpha = 1
					}}
				/>
			)}
			{/* Hover preview card — pinned to the node by the RAF loop. */}
			{showHoverCard && hovered && (
				<div
					ref={cardRef}
					className="pointer-events-none absolute left-0 top-0 z-50 w-56 -translate-x-1/2"
					style={{ willChange: 'transform' }}
				>
					<div className="bg-popover text-popover-foreground -translate-y-[calc(100%+14px)] overflow-hidden rounded-md border shadow-md">
						{hovered.image && (
							// eslint-disable-next-line @next/next/no-img-element
							<img
								src={hovered.image}
								alt=""
								className="aspect-video w-full object-cover"
							/>
						)}
						<div className="flex flex-col gap-1 p-3">
							<span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
								{hovered.type}
							</span>
							<span className="text-sm font-semibold leading-tight tracking-tight">
								{hovered.title}
							</span>
							{hovered.summary && (
								<span className="text-muted-foreground line-clamp-2 text-xs leading-snug">
									{hovered.summary}
								</span>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	)
}
