'use client'

import { createAppAbility } from '@/ability'
import { useModuleProgress } from '@/app/(content)/_components/module-progress-provider'
import { useWorkshopNavigation } from '@/app/(content)/workshops/_components/workshop-navigation-provider'
import type { Workshop } from '@/lib/workshops'
import { api } from '@/trpc/react'
import { subject } from '@casl/ability'
import { Check, ChevronRight, Lock } from 'lucide-react'

import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { WorkshopLessonItem } from './workshop-lesson-item'

/**
 * Renders a list of workshop resources (lessons and sections) in the cohort view.
 * Handles nested section structures with collapsible accordions.
 * Uses workshopNavigation from context which has full depth (sections + their children).
 */
export function WorkshopLessonList({
	workshop,
	className,
}: {
	workshop: Workshop
	className?: string
}) {
	const workshopNavigation = useWorkshopNavigation()
	const { moduleProgress } = useModuleProgress()

	const { data: abilityRules, status: abilityStatus } =
		api.ability.getCurrentAbilityRules.useQuery(
			{
				moduleId: workshopNavigation?.id,
			},
			{
				enabled: !!workshopNavigation?.id,
			},
		)

	const ability = createAppAbility(abilityRules || [])

	// Use workshopNavigation.resources which has full depth from getCachedWorkshopNavigation
	const resources = workshopNavigation?.resources ?? []

	let sectionCounter = 0

	return (
		<>
			{resources.map(({ resource }) => {
				if (resource.type === 'section') {
					sectionCounter++
					const childResources =
						resource.resources?.map((r) => r.resource).filter(Boolean) || []

					const sectionDoneCount = childResources.filter((item) =>
						moduleProgress?.completedLessons?.some(
							(progress) =>
								progress.resourceId === item.id && progress.completedAt,
						),
					).length

					const isSectionCompleted =
						childResources.length > 0 &&
						sectionDoneCount === childResources.length

					const isSectionLocked =
						abilityStatus === 'success' &&
						childResources.length > 0 &&
						childResources.every(
							(item) =>
								!ability.can('read', subject('Content', { id: item.id })),
						)

					return (
						<li key={resource.id} className="relative w-full list-none">
							<Accordion type="multiple">
								<AccordionItem value={resource.id} className="border-0">
									<AccordionTrigger
										className={cn(
											'hover:bg-card group relative flex w-full min-w-0 cursor-pointer items-center rounded-none border-b py-3 pl-4 pr-4 text-left transition-colors duration-150 ease-out hover:no-underline [&>svg]:hidden',
											isSectionLocked && 'text-foreground/50 hover:bg-card/50',
											className,
										)}
									>
										<div className="flex w-full items-center gap-2.5">
											<ChevronRight
												className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-200 ease-out group-data-[state=open]:rotate-90"
												aria-hidden="true"
												strokeWidth={2}
											/>
											<span
												className="text-muted-foreground/60 font-mono text-[10px] font-medium uppercase tabular-nums tracking-wider"
												aria-hidden="true"
											>
												{String(sectionCounter).padStart(2, '0')}
											</span>
											<h4 className="flex min-w-0 flex-1 items-center gap-1.5 pr-2 text-[14px] font-medium leading-tight tracking-[-0.005em]">
												{isSectionCompleted && (
													<Check
														className="text-foreground dark:text-primary -ml-0.5 size-3.5 shrink-0"
														aria-hidden="true"
														strokeWidth={2.4}
													/>
												)}
												<span className="truncate">
													{resource.fields?.title}
												</span>
											</h4>
											{isSectionLocked && (
												<Lock
													className="text-muted-foreground/60 size-3 shrink-0"
													aria-label="locked"
												/>
											)}
											{childResources.length > 0 && (
												<span
													className="text-muted-foreground/70 shrink-0 font-mono text-[10px] font-medium uppercase tabular-nums tracking-wider"
													aria-label={`${sectionDoneCount} of ${childResources.length} lessons completed`}
												>
													{sectionDoneCount}/{childResources.length}
												</span>
											)}
										</div>
									</AccordionTrigger>
									{childResources.length > 0 && (
										<AccordionContent className="pb-0">
											<ol className="bg-background/50 divide-border divide-y border-b">
												{childResources.map((item) => (
													<WorkshopLessonItem
														className={cn('pl-14', className)}
														key={item.id}
														resource={item}
														workshopSlug={workshop.fields.slug}
														ability={ability}
														abilityStatus={abilityStatus}
													/>
												))}
											</ol>
										</AccordionContent>
									)}
								</AccordionItem>
							</Accordion>
						</li>
					)
				}

				// Top-level lesson (not in a section)
				return (
					<WorkshopLessonItem
						className={cn(className)}
						key={resource.id}
						resource={resource}
						workshopSlug={workshop.fields.slug}
						ability={ability}
						abilityStatus={abilityStatus}
					/>
				)
			})}
		</>
	)
}
