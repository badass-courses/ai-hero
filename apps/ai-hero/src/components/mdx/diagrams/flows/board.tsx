import { cn } from '@coursebuilder/ui/utils/cn'

import { Flow, type FlowDiagram } from '../flow'

/**
 * Drawings Matt keeps side by side on one tldraw board, split by a dashed
 * rule. They sit side by side once the board is wide enough for each to keep
 * its two lanes, and stack in the same order below that.
 */
export function FlowBoard({ diagrams }: { diagrams: readonly FlowDiagram[] }) {
	return (
		// The grid sits inside its own container: a container query sizes
		// what is in the container, never the container itself.
		<div className="@container my-8">
			<div className="grid @2xl:auto-cols-fr @2xl:grid-flow-col">
				{diagrams.map((diagram, i) => (
					<div
						key={diagram.title}
						className={cn(
							i > 0 &&
								'border-border border-t-2 border-dashed @2xl:border-t-0 @2xl:border-l-2 @2xl:pl-8',
							i < diagrams.length - 1 && '@2xl:pr-8',
						)}
					>
						<Flow diagram={diagram} />
					</div>
				))}
			</div>
		</div>
	)
}
