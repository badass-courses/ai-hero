'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { HUE } from './ink'

/**
 * Matt's agent anatomy: the model inside the harness inside the agent (drawn
 * dashed), all inside the environment. Radii are his, in the drawing's units
 * with the centre at the origin.
 */
const RINGS = [
	{ id: 'environment', label: 'Environment', r: 265, hue: HUE.red },
	{
		id: 'agent',
		label: 'Agent',
		r: 117,
		hue: 'var(--foreground)',
		dashed: true,
	},
	{ id: 'harness', label: 'Harness', r: 82, hue: HUE.blue },
	{ id: 'model', label: 'Model', r: 36, hue: HUE.yellow },
] as const

/** The environment's contents, as he fills it in around the agent: nine
    hatched circles, clockwise from the top left. */
const SOURCES = [
	[-88, -177],
	[40, -188],
	[152, -115],
	[192, 23],
	[115, 154],
	[-9, 190],
	[-125, 140],
	[-187, 37],
	[-178, -83],
] as const

/**
 * The rings with their legend. `lit` is which of the environment's circles
 * this frame shows in full: none drawn yet, a few singled out with the rest
 * faint, or all of them.
 */
export function Rings({ lit }: { lit?: 'all' | readonly number[] }) {
	const hatch = React.useId()
	return (
		<figure className="not-prose @container my-8">
			<svg
				aria-hidden
				viewBox="-270 -270 540 540"
				className="mx-auto block w-full max-w-[420px]"
			>
				<defs>
					{/* The site's `.bg-stripes` hatch: a 6-unit band and a 6-unit gap
					    at 135°. */}
					<pattern
						id={hatch}
						width="12"
						height="12"
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<rect width="6" height="12" fill={HUE.red} />
					</pattern>
				</defs>
				{RINGS.map((ring) => (
					<circle
						key={ring.id}
						data-node={ring.id}
						r={ring.r}
						fill="none"
						stroke={ring.hue}
						strokeWidth="4"
						strokeDasharray={'dashed' in ring ? '11 8' : undefined}
					/>
				))}
				{lit
					? SOURCES.map(([cx, cy], i) => (
							<g
								key={i}
								data-node={`source-${i + 1}`}
								opacity={lit === 'all' || lit.includes(i) ? 1 : 0.3}
							>
								<circle
									cx={cx}
									cy={cy}
									r="50"
									fill={HUE.red}
									fillOpacity="0.12"
								/>
								<circle
									cx={cx}
									cy={cy}
									r="50"
									fill={`url(#${hatch})`}
									fillOpacity="0.3"
									stroke={HUE.red}
									strokeWidth="3"
								/>
							</g>
						))
					: null}
			</svg>
			<ul className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2">
				{RINGS.map((ring) => (
					<li
						key={ring.id}
						className={cn(TYPE.meta, 'flex items-center gap-2 font-bold')}
					>
						<span
							aria-hidden
							className="size-3.5 rounded-[4px] border-2"
							style={{
								borderColor: ring.hue,
								// The site's hatch (equal band and gap at 135°), scaled to a
								// swatch too small for its 12px period.
								backgroundImage: `repeating-linear-gradient(135deg, color-mix(in oklab, ${ring.hue} 45%, transparent) 0 2px, transparent 2px 4px)`,
							}}
						/>
						{ring.label}
					</li>
				))}
			</ul>
		</figure>
	)
}
