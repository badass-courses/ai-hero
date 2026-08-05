'use client'

import React from 'react'
import type { CohortNavigation } from '@/lib/cohort-navigation'

/**
 * The cohort a workshop sits in, made available to everything under the
 * workshop layout: the end-of-workshop handoff, the toolbar's next button, and
 * (next) the sidebar's position line.
 *
 * Null is a normal value, not an error — standalone workshops have no cohort —
 * so unlike `useContentNavigation` this hook stays quiet when there is no
 * provider above it.
 */
const CohortNavigationContext = React.createContext<CohortNavigation | null>(
	null,
)

export const CohortNavigationProvider = ({
	children,
	cohortNavDataLoader,
}: {
	children: React.ReactNode
	cohortNavDataLoader: Promise<CohortNavigation | null>
}) => {
	const cohortNavigation = React.use(cohortNavDataLoader)

	return (
		<CohortNavigationContext.Provider value={cohortNavigation}>
			{children}
		</CohortNavigationContext.Provider>
	)
}

export const useCohortNavigation = () => {
	return React.useContext(CohortNavigationContext)
}
