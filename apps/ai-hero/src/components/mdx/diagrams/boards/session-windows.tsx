import type * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { hueStyle, LINE_INK } from './hues'

/**
 * Sessions as Matt draws them: a context window with the 150k mark halfway
 * along and the dumb zone past it, and a hatched block for what the session
 * has filled so far. `fills` is how far each session gets, as a share of the
 * window; one session per window, top to bottom.
 */
export function SessionWindows({ fills }: { fills: readonly number[] }) {
	return (
		<figure className="not-prose @container my-8">
			<div className="space-y-8 @2xl:space-y-12">
				{fills.map((fill, i) => (
					<div key={i} data-node={`session-${i + 1}`}>
						<div className="relative mb-2 h-5">
							<span
								className={cn(
									TYPE.meta,
									'absolute bottom-0 -translate-x-1/2 font-bold',
								)}
								style={{ left: `${MARK * 100}%` }}
							>
								150k
							</span>
							<span
								className={cn(
									TYPE.cardTitle,
									'absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-(--ink)',
								)}
								style={{
									left: `${((1 + MARK) / 2) * 100}%`,
									...hueStyle('red'),
								}}
							>
								Dumb Zone
							</span>
						</div>
						<div
							className={cn(
								LINE_INK,
								'relative h-16 rounded-[9px] border-[3px] border-current @2xl:h-24',
							)}
						>
							<span
								aria-hidden
								className="absolute inset-y-0 border-l-[3px] border-dashed border-current"
								style={{ left: `${MARK * 100}%` }}
							/>
							<span
								role="img"
								aria-label={`A session filled to ${Math.round(fill * 100)}% of the window`}
								className="absolute inset-y-2 left-2 rounded-[6px] border-[3px] border-(--edge) @2xl:inset-y-3 @2xl:left-3"
								style={
									{
										width: `${fill * 100}%`,
										...hueStyle('blue'),
										'--hatch':
											'color-mix(in oklab, var(--hue) 50%, transparent)',
										backgroundImage:
											'repeating-linear-gradient(45deg, var(--hatch) 0 1.5px, transparent 1.5px 5px), repeating-linear-gradient(-45deg, var(--hatch) 0 1.5px, transparent 1.5px 5px)',
									} as React.CSSProperties
								}
							/>
						</div>
					</div>
				))}
			</div>
		</figure>
	)
}

/** Where 150k falls along the window in Matt's drawing. */
const MARK = 0.5
