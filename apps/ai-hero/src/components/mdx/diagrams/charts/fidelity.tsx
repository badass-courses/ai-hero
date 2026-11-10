import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { INK } from './ink'

/**
 * Where each label sits along the arrow, as a share of its length from the
 * head, read off Matt's drawing: the poles beside its two ends, the four
 * kinds of artefact spaced up the other side.
 */
const POLES = [
	{ label: 'High Fidelity', at: 0.014 },
	{ label: 'Low Fidelity', at: 0.97 },
] as const
const RUNGS = [
	{ label: 'Working Code', at: 0.11 },
	{ label: 'Wireframes', at: 0.36 },
	{ label: 'Breadboards', at: 0.65 },
	{ label: 'Discussion', at: 0.92 },
] as const

/** Matt's fidelity axis: an arrow up from Low to High Fidelity, with what you
    make at each height beside it. */
export function FidelityAxis() {
	return (
		<figure className="not-prose @container my-8">
			<div className="relative mx-auto grid h-[22rem] max-w-[560px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1.15fr)]">
				<Column items={POLES} className="pr-4 text-right @2xl:pr-10" />
				<div aria-hidden className="relative w-4" data-edge="low-high">
					<span
						className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2"
						style={{ background: INK }}
					/>
					<svg
						viewBox="0 0 16 10"
						className="absolute -top-2 left-0 w-4 overflow-visible"
						style={{ color: INK }}
					>
						<path d="M8 0 L13 10 L3 10 Z" fill="currentColor" />
					</svg>
				</div>
				<Column items={RUNGS} className="pl-6 @2xl:pl-16" />
			</div>
		</figure>
	)
}

function Column({
	items,
	className,
}: {
	items: readonly { label: string; at: number }[]
	className: string
}) {
	return (
		<ul className="relative">
			{items.map((item) => (
				<li
					key={item.label}
					data-node={item.label}
					className={cn(
						TYPE.subhead,
						'absolute inset-x-0 -translate-y-1/2 whitespace-nowrap',
						className,
					)}
					style={{ top: `${item.at * 100}%` }}
				>
					{item.label}
				</li>
			))}
		</ul>
	)
}
