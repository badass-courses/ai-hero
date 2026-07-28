import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import {
	Clock,
	Infinity as InfinityIcon,
	Layers,
	LineChart,
	MessagesSquare,
	Receipt,
	Subtitles,
} from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * What every seat comes with. These are product facts, not per-cohort data,
 * so they live here as a list a human can edit. The workshop count is the one
 * live value and is prepended by the component.
 */
const COHORT_INCLUDES = [
	{ icon: Clock, label: 'Live office hours' },
	{ icon: InfinityIcon, label: 'Lifetime access to lessons' },
	{ icon: Receipt, label: 'Customizable invoice' },
	{ icon: Subtitles, label: 'English transcripts & subtitles' },
	{ icon: LineChart, label: 'Progress tracking' },
	{ icon: MessagesSquare, label: 'Access to the Discord community' },
] as const

/**
 * Closes out the sticky rail in all three of its states (waitlist, pricing,
 * purchased). Someone weighing the cohort and someone already enrolled both
 * want the same answer to "what do I actually get", so it never branches.
 */
export const CohortIncludes: React.FC<{
	workshopCount: number
	className?: string
}> = ({ workshopCount, className }) => {
	return (
		<section className={cn('border-t px-5 py-6', className)}>
			<h2 className={cn(TYPE.subhead, 'mb-4')}>Includes</h2>
			<ul className="flex flex-col gap-3">
				{workshopCount > 0 && (
					<Item icon={Layers}>
						{workshopCount} {workshopCount === 1 ? 'workshop' : 'workshops'}
					</Item>
				)}
				{COHORT_INCLUDES.map(({ icon, label }) => (
					<Item key={label} icon={icon}>
						{label}
					</Item>
				))}
			</ul>
		</section>
	)
}

const Item: React.FC<{
	icon: React.ElementType
	children: React.ReactNode
}> = ({ icon: Icon, children }) => (
	<li className={cn(TYPE.metaProse, 'flex items-center gap-3')}>
		<Icon
			className="size-4 shrink-0 text-[color:var(--ah-fg-subtle)]"
			aria-hidden="true"
			strokeWidth={1.75}
		/>
		<span className="text-[color:var(--ah-fg-body)]">{children}</span>
	</li>
)
