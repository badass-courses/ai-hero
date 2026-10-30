import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { LINE_INK } from './hues'

/** The course plan as Matt lays it out: when, then what, one column each. */
const COURSE_PLAN = [
	{ when: 'Now', what: ['Crash Course', 'Before We Start'] },
	{
		when: 'Week 1',
		what: ['Domain Language', 'Wayfinder', 'Review', 'Codebase Design'],
	},
	{
		when: 'Week 2',
		what: ['Feedback Loops', 'Software Factory #1', 'Software Factory #2'],
	},
] as const

/**
 * Matt's course roadmap: three columns headed in his accent, the headings
 * kept apart from the sections by one dashed rule across the board.
 */
export function Roadmap() {
	return (
		<figure className="not-prose @container my-8">
			<div className="grid grid-cols-[1fr_1.15fr_1.15fr] gap-x-3 @2xl:grid-cols-[1fr_1.05fr_1fr] @2xl:gap-x-8">
				{COURSE_PLAN.map((column) => (
					<span
						key={column.when}
						className={cn(TYPE.cardTitle, 'text-primary')}
					>
						{column.when}
					</span>
				))}
				<div
					aria-hidden
					className={cn(
						LINE_INK,
						'col-span-3 my-4 border-t-2 border-dashed border-current @2xl:my-5',
					)}
				/>
				{COURSE_PLAN.map((column) => (
					<ul
						key={column.when}
						aria-label={column.when}
						className="space-y-4 @2xl:space-y-5"
					>
						{column.what.map((section) => (
							<li key={section} className={cn(TYPE.cardTitle, 'text-pretty')}>
								{section}
							</li>
						))}
					</ul>
				))}
			</div>
		</figure>
	)
}
