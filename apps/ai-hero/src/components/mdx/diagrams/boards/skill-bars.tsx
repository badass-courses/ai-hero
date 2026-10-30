import type * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { hueStyle, type BoardHue } from './hues'

/**
 * Two skills as rows of blocks, each block as long as Matt drew it (measured
 * off his board, in his pixels) so the rows compare at a glance. A block with
 * no hue is the empty, unused stretch at the end of a row.
 */
const ROWS: readonly {
	skill: string
	blocks: readonly [number, BoardHue?][]
}[] = [
	{
		skill: '/implement',
		blocks: [
			[32, 'slate'],
			[90, 'amber'],
			[177, 'green'],
			[81, 'purple'],
			[86],
		],
	},
	{
		skill: '/code-review',
		blocks: [
			[32, 'slate'],
			[19, 'amber'],
			[84, 'green'],
			[80, 'purple'],
			[251],
		],
	},
]

/** Matt's /implement and /code-review side by side as coloured bars. He
    leaves the blocks unlabelled; the lesson says what each one is. */
export function SkillBars() {
	return (
		<figure className="not-prose @container my-8">
			<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-7 @2xl:gap-x-6 @2xl:gap-y-10">
				{ROWS.map((row) => (
					<div
						key={row.skill}
						data-node={row.skill}
						className="col-span-2 grid grid-cols-subgrid items-center"
					>
						<span
							className={cn(
								TYPE.cardTitle,
								'text-right font-mono tracking-normal',
							)}
						>
							{row.skill}
						</span>
						<div aria-hidden className="flex h-8 gap-1.5 @2xl:h-10 @2xl:gap-3">
							{row.blocks.map(([length, hue], i) => (
								<span
									key={i}
									className={cn(
										'min-w-2 rounded-[6px] border-2',
										hue
											? 'border-(--edge) bg-(--wash)'
											: 'border-border bg-muted/40',
									)}
									style={
										{
											flex: `${length} 1 0`,
											...(hue ? hueStyle(hue) : {}),
										} as React.CSSProperties
									}
								/>
							))}
						</div>
					</div>
				))}
			</div>
		</figure>
	)
}
