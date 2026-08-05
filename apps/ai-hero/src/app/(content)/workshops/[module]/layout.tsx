import React from 'react'
import { ModuleProgressProvider } from '@/app/(content)/_components/module-progress-provider'
import { CohortNavigationProvider } from '@/app/(content)/workshops/_components/cohort-navigation-provider'
import { WorkshopNavigationProvider } from '@/app/(content)/workshops/_components/workshop-navigation-provider'
import { getCohortFromNavigation } from '@/lib/cohort-navigation'
import { getCachedCohortNavigation } from '@/lib/cohort-navigation-query'
import { getModuleProgressForUser } from '@/lib/progress'
import { getCachedWorkshopNavigation } from '@/lib/workshops-query'
import { log } from '@/server/logger'

const ModuleLayout = async (props: {
	params: Promise<{ module: string }>
	children: React.ReactNode
}) => {
	const params = await props.params

	const { children } = props

	const workshopNavDataLoader = getCachedWorkshopNavigation(params.module)
	const moduleProgressLoader = getModuleProgressForUser(params.module)

	// Chained, not awaited: the cohort id only exists once the workshop nav
	// resolves, but awaiting it here would block the whole layout — and the
	// providers below take promises precisely so the shell can stream. Both
	// reads are cached, so a workshop in a cohort costs one extra cache hit.
	//
	// `.catch` matters: `React.use` rethrows a rejected promise, so without it a
	// database blip on OPTIONAL navigation data would escalate to the nearest
	// error boundary and take the lesson down with it. Null is already the
	// contract for "no cohort", so degrading to it costs the next-workshop
	// affordance and nothing else.
	const cohortNavDataLoader = workshopNavDataLoader
		.then((navigation) => {
			const cohort = getCohortFromNavigation(navigation)
			return cohort ? getCachedCohortNavigation(cohort.id) : null
		})
		.catch((error) => {
			void log.error('cohort-navigation.load.error', {
				module: params.module,
				error: error instanceof Error ? error.message : String(error),
			})
			return null
		})

	return (
		<WorkshopNavigationProvider workshopNavDataLoader={workshopNavDataLoader}>
			{/*
			 * key by module: the [module] layout is a shared segment that React
			 * does NOT remount when only the param changes, so the provider's
			 * durable useReducer state would otherwise carry one module's progress
			 * into another. Keying remounts it per module (fresh server progress)
			 * while staying durable across lesson-to-lesson navigation within a module.
			 */}
			<ModuleProgressProvider
				key={params.module}
				moduleProgressLoader={moduleProgressLoader}
			>
				<CohortNavigationProvider cohortNavDataLoader={cohortNavDataLoader}>
					{children}
				</CohortNavigationProvider>
			</ModuleProgressProvider>
		</WorkshopNavigationProvider>
	)
}

export default ModuleLayout
