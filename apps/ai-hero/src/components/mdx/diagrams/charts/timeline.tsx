'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { HUE, INK } from './ink'

export type TimelineStep = { label: string; hue: string }

/** What runs a step: a human in the loop, an agent while you are away from
    the keyboard, or either. */
export type TimelineMarker = 'HITL' | 'AFK' | 'AFK / HITL'

/**
 * Matt's timelines: coloured steps along a bracketed rule, each with a tick
 * down to it. On a desktop the rule runs across under the steps, as he draws
 * it; on a phone it runs down their left side, in the same order, so the
 * labels never have to shrink.
 */
export function Timeline({
	steps,
	markers,
	agents = false,
	arcs = [],
}: {
	steps: readonly TimelineStep[]
	/** One per step, in step order. */
	markers?: readonly TimelineMarker[]
	/** Each step runs in a sandbox of its own, with one agent in it. */
	agents?: boolean
	/** Arrows that skip ahead along the timeline, by step index. */
	arcs?: readonly (readonly [from: number, to: number])[]
}) {
	const listRef = React.useRef<HTMLOListElement>(null)
	const paths = useArcs(listRef, arcs)
	const last = steps.length - 1

	return (
		<figure className="not-prose @container my-8">
			<ol
				ref={listRef}
				style={{ '--ink': INK } as React.CSSProperties}
				className={cn(
					'relative mx-auto flex w-fit flex-col [--timeline-layout:narrow] @2xl:w-full @2xl:max-w-[760px] @2xl:flex-row @2xl:items-start @2xl:px-6 @2xl:[--timeline-layout:wide]',
					arcs.length > 0 && '@2xl:pt-28',
				)}
			>
				{steps.map((step, i) => {
					const marker = markers?.[i]
					return (
						<React.Fragment key={i}>
							{i > 0 ? (
								<li
									aria-hidden
									className="ml-0 h-3 w-[3px] shrink-0 bg-[var(--ink)] @2xl:mt-[53px] @2xl:h-[3px] @2xl:w-auto @2xl:min-w-5 @2xl:flex-1"
								/>
							) : null}
							<li
								data-node={`step-${i}`}
								className="flex items-center gap-3 @2xl:flex-col @2xl:items-stretch @2xl:gap-0"
							>
								<span
									data-step-label
									className="flex h-8 items-center gap-2 whitespace-nowrap @2xl:order-first @2xl:justify-center @2xl:pb-2"
								>
									<span
										data-step-dot
										aria-hidden
										className="size-3.5 shrink-0 rounded-full border-[3px]"
										style={{ borderColor: step.hue }}
									/>
									<span className={TYPE.subhead}>{step.label}</span>
								</span>
								<Tick first={i === 0} last={i === last} />
								{marker || agents ? (
									<span className="flex items-center gap-3 @2xl:mt-3 @2xl:flex-col @2xl:gap-4">
										{marker ? <Marker marker={marker} /> : null}
										{agents ? <SandboxAgent /> : null}
									</span>
								) : null}
							</li>
						</React.Fragment>
					)
				})}
				{paths.length > 0 ? (
					<svg
						aria-hidden
						className="pointer-events-none absolute inset-0 size-full overflow-visible text-[var(--ink)]"
					>
						{paths.map((path) => (
							<g key={path.key} data-edge={path.key}>
								<path
									d={path.d}
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
								/>
								<path d={path.head} fill="currentColor" />
							</g>
						))}
					</svg>
				) : null}
			</ol>
			{arcs.length > 0 ? (
				<ul className="sr-only">
					{arcs.map(([from, to]) => (
						<li key={`${from}-${to}`}>
							{steps[from]!.label} leads to {steps[to]!.label}
						</li>
					))}
				</ul>
			) : null}
		</figure>
	)
}

/**
 * A step's tick and its stretch of the rule. Wide, the tick drops from the
 * label and the rule runs along its foot; narrow, the tick reaches right to
 * the label and the rule runs down its left. The rule stops at the middle of
 * the first and last steps, which closes it into a bracket.
 */
function Tick({ first, last }: { first: boolean; last: boolean }) {
	return (
		<span
			aria-hidden
			className="relative order-first w-6 shrink-0 self-stretch @2xl:order-none @2xl:h-6 @2xl:w-auto @2xl:self-auto"
		>
			<span
				className={cn(
					'absolute left-0 w-[3px] bg-[var(--ink)] @2xl:top-auto @2xl:bottom-0 @2xl:h-[3px] @2xl:w-auto',
					first ? 'top-1/2' : 'top-0',
					last ? 'bottom-1/2' : 'bottom-0',
					first ? '@2xl:left-1/2' : '@2xl:left-0',
					last ? '@2xl:right-1/2' : '@2xl:right-0',
				)}
			/>
			<span className="absolute top-1/2 right-0 left-0 h-[3px] -translate-y-1/2 bg-[var(--ink)] @2xl:top-0 @2xl:right-auto @2xl:bottom-0 @2xl:left-1/2 @2xl:h-auto @2xl:w-[3px] @2xl:-translate-x-1/2 @2xl:translate-y-0" />
		</span>
	)
}

function Marker({ marker }: { marker: TimelineMarker }) {
	if (marker === 'AFK / HITL')
		return (
			<span className="flex items-center gap-1.5">
				<Badge kind="AFK" />
				<span className={cn(TYPE.subhead, 'text-foreground')}>/</span>
				<Badge kind="HITL" />
			</span>
		)
	return <Badge kind={marker} />
}

/** Matt's badges are dark chips with a rim: indigo for AFK, grey for HITL. */
function Badge({ kind }: { kind: 'AFK' | 'HITL' }) {
	return (
		<span
			className={cn(
				TYPE.badge,
				'bg-muted text-foreground rounded-[4px] border-2 px-[7px] py-[5px]',
			)}
			style={{
				borderColor:
					kind === 'AFK'
						? HUE.indigo
						: 'color-mix(in oklab, var(--foreground) 45%, var(--background))',
			}}
		>
			{kind}
		</span>
	)
}

/** One sandbox equals one agent: Matt's sandbox (a drive-like box) and his
    bot icon either side of an equals sign. */
function SandboxAgent() {
	return (
		<span className="text-foreground flex items-center gap-2">
			<span className="sr-only">One sandbox = one agent</span>
			<svg aria-hidden viewBox="0 0 70 22" className="h-[22px] w-[70px]">
				<g
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<rect x="1" y="7" width="22" height="11" rx="3" />
					<circle cx="6" cy="12.5" r="0.6" fill="currentColor" />
					<path d="M29 10.5h9M29 15h9" strokeWidth="2.5" />
					<rect x="46" y="6" width="16" height="15" rx="3" />
					<path d="M54 6V2h4M44 13.5h2M62 13.5h2M51 11.5v3M57 11.5v3" />
				</g>
			</svg>
		</span>
	)
}

type ArcPath = { key: string; d: string; head: string }

/** Measures the arcs from where the steps landed, wide or narrow, and redraws
    them whenever the timeline resizes. */
function useArcs(
	listRef: React.RefObject<HTMLOListElement | null>,
	arcs: readonly (readonly [number, number])[],
) {
	const [paths, setPaths] = React.useState<ArcPath[]>([])

	React.useLayoutEffect(() => {
		const list = listRef.current
		if (!list || arcs.length === 0) return

		const draw = () => {
			const origin = list.getBoundingClientRect()
			const labels = [
				...list.querySelectorAll<HTMLElement>('[data-step-label]'),
			]
			const wide =
				getComputedStyle(list).getPropertyValue('--timeline-layout').trim() ===
				'wide'
			setPaths(
				arcs.flatMap(([from, to]) => {
					const a = labels[from]
					const b = labels[to]
					if (!a || !b) return []
					return [
						{
							key: `step-${from}-step-${to}`,
							...(wide ? over(a, b, origin) : beside(a, b, origin)),
						},
					]
				}),
			)
		}

		draw()
		const observer = new ResizeObserver(draw)
		observer.observe(list)
		return () => observer.disconnect()
	}, [listRef, arcs])

	return paths
}

/** Wide: a hump from the top of one step's dot over to the top left of the
    next one's, higher the further it reaches, as Matt draws it. */
function over(a: HTMLElement, b: HTMLElement, origin: DOMRect) {
	const da = dotOf(a, origin)
	const db = dotOf(b, origin)
	const start = { x: da.x + 3, y: da.top - 4 }
	const end = { x: db.x - 5, y: db.top - 5 }
	const span = end.x - start.x
	const lift = 0.3 * span + 20
	const d = `M${start.x},${start.y} C${start.x + span * 0.12},${start.y - lift} ${end.x - span * 0.12},${end.y - lift} ${end.x},${end.y}`
	return { d, head: headAt(end, { x: span * 0.12, y: lift }) }
}

/** Narrow: a bow out to the right from the end of one label back into the
    end of the next. */
function beside(a: HTMLElement, b: HTMLElement, origin: DOMRect) {
	const ra = a.getBoundingClientRect()
	const rb = b.getBoundingClientRect()
	const start = {
		x: ra.right - origin.left + 8,
		y: ra.top - origin.top + ra.height / 2,
	}
	const end = {
		x: rb.right - origin.left + 8,
		y: rb.top - origin.top + rb.height / 2,
	}
	const reach = Math.max(start.x, end.x) + 20 + (end.y - start.y) * 0.15
	const d = `M${start.x},${start.y} C${reach},${start.y} ${reach},${end.y} ${end.x},${end.y}`
	return { d, head: headAt(end, { x: -1, y: 0 }) }
}

function dotOf(label: HTMLElement, origin: DOMRect) {
	const dot = label.querySelector('[data-step-dot]')!.getBoundingClientRect()
	return {
		x: dot.left - origin.left + dot.width / 2,
		top: dot.top - origin.top,
	}
}

/** A filled arrowhead, the house style's, with its tip at `tip` pointing
    along `dir`. */
function headAt(tip: { x: number; y: number }, dir: { x: number; y: number }) {
	const n = Math.hypot(dir.x, dir.y)
	const dx = dir.x / n
	const dy = dir.y / n
	const bx = tip.x - dx * 8
	const by = tip.y - dy * 8
	return `M${tip.x},${tip.y}L${bx - dy * 4.5},${by + dx * 4.5}L${bx + dy * 4.5},${by - dx * 4.5}Z`
}
