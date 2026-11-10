import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { INK } from './ink'

/**
 * The plot in Matt's own units, read off the original: the axes' corner is
 * the origin and y runs up. The curve is one cubic fitted to his, rising
 * steeply and flattening, and each bucket of agents drops a dotted line from
 * it to the x axis.
 */
const WIDTH = 763
const HEIGHT = 545
const CURVE = [
	[33, 0],
	[293, 322],
	[381, 371],
	[761, 477],
] as const
const BUCKETS = [
	{ label: '1-5', x: 162 },
	{ label: '6-10', x: 298 },
	{ label: '10-25', x: 436 },
	{ label: '26+', x: 551 },
	{ label: '50+', x: 655 },
] as const

/**
 * Trust against the number of agents. The curve is SVG; the axes, the dotted
 * drops and every label are HTML placed by percentage, so the text keeps its
 * size and the lines stay crisp at any width.
 */
export function TrustCurve() {
	return (
		<figure className="not-prose @container my-8">
			<figcaption className="sr-only">
				Trust plotted against the number of agents: 1-5, 6-10, 10-25, 26+ and
				50+. The curve rises steeply over the first buckets, then flattens.
			</figcaption>
			<div className="mx-auto grid max-w-[640px] grid-cols-[auto_minmax(0,1fr)] gap-x-4 @2xl:gap-x-8">
				<span data-node="trust" className={cn(TYPE.subhead, 'self-center')}>
					Trust
				</span>
				<div
					className="relative aspect-[763/545] border-b-[3px] border-l-[3px]"
					style={{ borderColor: INK }}
				>
					{BUCKETS.map((b) => (
						<span
							key={b.label}
							aria-hidden
							className="border-foreground/70 absolute bottom-0 -translate-x-1/2 border-l-2 border-dotted"
							style={{
								left: pct(b.x, WIDTH),
								height: pct(heightAt(b.x), HEIGHT),
							}}
						/>
					))}
					<svg
						aria-hidden
						viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
						className="text-foreground absolute inset-0 size-full overflow-visible"
					>
						<path
							data-edge="trust-agents"
							d={`M${flip(CURVE[0])} C${flip(CURVE[1])} ${flip(CURVE[2])} ${flip(CURVE[3])}`}
							fill="none"
							stroke="currentColor"
							strokeWidth="3.5"
							strokeLinecap="round"
							vectorEffect="non-scaling-stroke"
						/>
					</svg>
				</div>
				<span />
				<ul className="relative h-8">
					{BUCKETS.map((b) => (
						<li
							key={b.label}
							data-node={b.label}
							className={cn(
								TYPE.meta,
								'absolute top-2 -translate-x-1/2 font-bold whitespace-nowrap',
							)}
							style={{ left: pct(b.x, WIDTH) }}
						>
							{b.label}
						</li>
					))}
				</ul>
				<span />
				<span
					data-node="agents"
					className={cn(TYPE.subhead, 'mt-5 block text-center @2xl:mt-7')}
				>
					Agents
				</span>
			</div>
		</figure>
	)
}

function pct(value: number, of: number) {
	return `${(value / of) * 100}%`
}

/** A point in SVG's coordinates, where y runs down. */
function flip([x, y]: readonly [number, number]) {
	return `${x},${HEIGHT - y}`
}

/** The curve's height over `x`, found by bisecting the cubic along its
    parameter, so a dotted drop meets the curve exactly. */
function heightAt(x: number) {
	const at = (t: number, axis: 0 | 1) => {
		const [p0, p1, p2, p3] = CURVE.map((p) => p[axis]) as [
			number,
			number,
			number,
			number,
		]
		const u = 1 - t
		return (
			u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
		)
	}
	let lo = 0
	let hi = 1
	for (let i = 0; i < 30; i++) {
		const mid = (lo + hi) / 2
		if (at(mid, 0) < x) lo = mid
		else hi = mid
	}
	return at(lo, 1)
}
