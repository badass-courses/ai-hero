import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import type { Workshop } from '@/lib/workshops'
import { getCachedWorkshopNavigation } from '@/lib/workshops-query'
import { formatCohortDateRange } from '@/utils/format-cohort-date'
import { ChevronRight } from 'lucide-react'

import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

import { ModuleProgressProvider } from '../../../_components/module-progress-provider'
import { WorkshopNavigationProvider } from '../../../workshops/_components/workshop-navigation-provider'
import { WorkshopLessonList } from './cohort-list/workshop-lesson-list'
import WorkshopSidebarItem from './cohort-list/workshop-sidebar-item'

/**
 * The cohort's workshop/lesson tree. It appears twice on the page — in the
 * sticky rail once you own the cohort, and in full at the bottom of the body
 * for everyone — so there is one component and a variant rather than two
 * lists that drift apart.
 *
 * Both variants render every lesson title server-side, locked or not: the
 * titles are the thing a buyer is evaluating and search engines should index
 * them. `WorkshopLessonItem` handles the lock affordance (visible row, no
 * link, lock glyph at the right).
 */
export const CohortContents: React.FC<{
	workshops: Workshop[]
	workshopProgressMap: Map<string, Promise<any>>
	/** Fallback timezone for the "available from" line. */
	timezone: string
	variant: 'rail' | 'full'
	className?: string
}> = ({ workshops, workshopProgressMap, timezone, variant, className }) => {
	if (workshops.length === 0) return null

	const isRail = variant === 'rail'

	return (
		<section className={className}>
			{isRail ? (
				<h2 className="flex h-12 items-center border-b px-4 text-[14px] font-semibold tracking-tight">
					Workshops
				</h2>
			) : (
				<div className="px-5 sm:px-8 lg:px-10">
					<h2 className={cn(TYPE.heading, 'mb-5')}>Contents</h2>
				</div>
			)}
			<div className="flex w-full">
				<ol
					className={cn(
						'divide-border flex w-full flex-col divide-y',
						!isRail && 'border-y',
					)}
				>
					{workshops.map((workshop, index) => {
						const workshopTimezone = workshop.fields.timezone || timezone
						const { dateString: workshopDateString } = formatCohortDateRange(
							workshop.fields.startsAt,
							null,
							workshopTimezone,
						)
						const moduleProgressLoader =
							workshopProgressMap.get(workshop.fields.slug) ||
							Promise.resolve(null)

						return (
							<li key={workshop.id}>
								<ModuleProgressProvider
									moduleProgressLoader={moduleProgressLoader}
								>
									<Accordion
										type="multiple"
										// The full list is a sales argument, so it opens; the rail
										// is navigation and stays collapsed to the active branch.
										defaultValue={isRail ? undefined : [`${workshop.id}-body`]}
									>
										<AccordionItem
											value={`${workshop.id}-body`}
											className={cn(
												'transition-colors ease-out',
												isRail
													? 'data-[state=open]:bg-muted/60'
													: 'data-[state=open]:bg-card/50 border-none',
											)}
										>
											{isRail ? (
												<WorkshopSidebarItem
													index={index + 1}
													workshop={workshop}
												/>
											) : (
												<AccordionTrigger className="hover:bg-card text-foreground group relative flex w-full min-w-0 cursor-pointer items-start rounded-none py-3 pl-4 pr-4 text-left transition-colors duration-150 ease-out hover:no-underline [&>svg]:hidden">
													<div className="flex w-full items-start gap-2.5">
														<ChevronRight
															className="text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform duration-200 ease-out group-data-[state=open]:rotate-90"
															aria-hidden="true"
															strokeWidth={2}
														/>
														<span
															className="text-muted-foreground/60 mt-0.5 shrink-0 font-mono text-[10px] font-medium uppercase tabular-nums tracking-wider"
															aria-hidden="true"
														>
															{String(index + 1).padStart(2, '0')}
														</span>
														<div className="flex min-w-0 flex-1 flex-col gap-1">
															<h3 className="truncate text-[14px] font-medium leading-tight tracking-[-0.005em]">
																{workshop.fields.title}
															</h3>
															<span className="text-muted-foreground/70 truncate font-mono text-[10px] font-medium uppercase tracking-wider">
																{workshopDateString
																	? `Available from ${workshopDateString}`
																	: 'Available today'}
															</span>
														</div>
													</div>
												</AccordionTrigger>
											)}
											{workshop.resources && workshop.resources.length > 0 && (
												<AccordionContent
													className={cn('pb-0', !isRail && 'border-t')}
												>
													<ol
														className={cn(
															'divide-border list-inside list-none divide-y',
															isRail && 'border-t',
														)}
													>
														<WorkshopLessonRows workshop={workshop} />
													</ol>
												</AccordionContent>
											)}
										</AccordionItem>
									</Accordion>
								</ModuleProgressProvider>
							</li>
						)
					})}
				</ol>
				{!isRail && (
					<div className="bg-stripes hidden min-h-0 w-4 shrink-0 border-y border-l sm:flex" />
				)}
			</div>
		</section>
	)
}

/**
 * Bridges the workshop's navigation loader into the client list. Kept server
 * side so the lesson titles are in the first HTML response.
 */
const WorkshopLessonRows: React.FC<{ workshop: Workshop }> = ({ workshop }) => {
	const workshopNavDataLoader = getCachedWorkshopNavigation(
		workshop.fields.slug,
	)

	return (
		<WorkshopNavigationProvider workshopNavDataLoader={workshopNavDataLoader}>
			<WorkshopLessonList workshop={workshop} />
		</WorkshopNavigationProvider>
	)
}
