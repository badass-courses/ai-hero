'use client'

import { useModuleProgress } from '@/app/(content)/_components/module-progress-provider'
import type { Workshop } from '@/lib/workshops'
import { Check, ChevronRight } from 'lucide-react'

import { AccordionTrigger } from '@coursebuilder/ui'

export default function WorkshopSidebarItem({
	workshop,
	index,
}: {
	workshop: Workshop
	index: number
}) {
	const { moduleProgress } = useModuleProgress()
	const isWorkshopCompleted = Boolean(
		moduleProgress?.percentCompleted && moduleProgress.percentCompleted >= 100,
	)
	const completedCount = moduleProgress?.completedLessonsCount ?? 0
	const totalCount = moduleProgress?.totalLessonsCount ?? 0
	const displayTitle = workshop.fields.title.includes(':')
		? (workshop.fields.title.split(':')[1]?.trim() ?? workshop.fields.title)
		: workshop.fields.title

	return (
		<AccordionTrigger className="hover:bg-card text-foreground group relative flex w-full min-w-0 cursor-pointer items-center rounded-none py-3 pl-4 pr-4 text-left transition-colors duration-150 ease-out hover:no-underline [&>svg]:hidden">
			<div className="flex w-full items-center gap-2.5">
				<ChevronRight
					className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-200 ease-out group-data-[state=open]:rotate-90"
					aria-hidden="true"
					strokeWidth={2}
				/>
				<span
					className="text-muted-foreground/60 shrink-0 font-mono text-[10px] font-medium uppercase tabular-nums tracking-wider"
					aria-hidden="true"
				>
					{String(index).padStart(2, '0')}
				</span>
				<h3 className="flex min-w-0 flex-1 items-center gap-1.5 pr-2 text-[14px] font-medium leading-tight tracking-[-0.005em]">
					{isWorkshopCompleted && (
						<Check
							className="text-foreground dark:text-primary -ml-0.5 size-3.5 shrink-0"
							aria-hidden="true"
							strokeWidth={2.4}
						/>
					)}
					<span className="truncate">{displayTitle}</span>
				</h3>
				{totalCount > 0 && (
					<span
						className="text-muted-foreground/70 shrink-0 font-mono text-[10px] font-medium uppercase tabular-nums tracking-wider"
						aria-label={`${completedCount} of ${totalCount} lessons completed`}
					>
						{completedCount}/{totalCount}
					</span>
				)}
			</div>
		</AccordionTrigger>
	)
}
