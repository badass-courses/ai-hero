import type * as React from 'react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { Flow, type FlowDiagram } from '../flow'

type Drawing = { diagram: FlowDiagram }

/**
 * Drawings Matt keeps side by side on one tldraw board, split by a dashed
 * rule: his template column first when the frame shows it, narrower, as on
 * his board. Two columns sit side by side once the board is wide enough for
 * each to keep its two lanes; three need more room, so below that they stack
 * in the same order.
 */
export function FlowBoard({
	template,
	drawings,
}: {
	template?: FlowDiagram
	drawings: readonly Drawing[]
}) {
	const columns: (Drawing & { weight: number })[] = [
		...(template ? [{ diagram: template, weight: 2 }] : []),
		...drawings.map((drawing) => ({ ...drawing, weight: 3 })),
	]
	const three = columns.length > 2

	return (
		// The grid sits inside its own container: a container query sizes
		// what is in the container, never the container itself.
		<div className="@container my-8">
			<div
				className={cn(
					'grid',
					three
						? '@5xl:[grid-template-columns:var(--board-cols)]'
						: '@2xl:[grid-template-columns:var(--board-cols)]',
				)}
				style={
					{
						'--board-cols': columns
							.map(({ weight }) => `minmax(0, ${weight}fr)`)
							.join(' '),
					} as React.CSSProperties
				}
			>
				{columns.map(({ diagram }, i) => (
					<div
						key={diagram.title}
						className={cn(
							i > 0 && 'border-border border-t-2 border-dashed',
							i > 0 &&
								(three
									? '@5xl:border-t-0 @5xl:border-l-2 @5xl:pl-8'
									: '@2xl:border-t-0 @2xl:border-l-2 @2xl:pl-8'),
							i < columns.length - 1 && (three ? '@5xl:pr-8' : '@2xl:pr-8'),
						)}
					>
						<Flow diagram={diagram} />
					</div>
				))}
			</div>
		</div>
	)
}
