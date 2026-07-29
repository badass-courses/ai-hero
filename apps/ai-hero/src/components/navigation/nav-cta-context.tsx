'use client'

import * as React from 'react'
import type { CohortOffer } from '@/lib/nav-cta'

/**
 * Carries the server-resolved {@link CohortOffer} down to `Navigation`.
 *
 * Context rather than a prop because `Navigation` is rendered inside
 * `LayoutClient`, itself a client component with ~80 call sites — threading a
 * prop would mean touching every page. The root layout is a server component,
 * so it can await the offer and hand it over here, which means the value is
 * present in the very first paint: no client fetch, no reflow.
 *
 * `null` is a real answer ("no cohort exists"), so the default is `undefined`
 * to keep "provider missing" distinguishable.
 */
const NavCtaContext = React.createContext<CohortOffer | null | undefined>(
	undefined,
)

export function NavCtaProvider({
	value,
	children,
}: {
	value: CohortOffer | null
	children: React.ReactNode
}) {
	return <NavCtaContext.Provider value={value}>{children}</NavCtaContext.Provider>
}

export function useCohortOffer(): CohortOffer | null {
	return React.useContext(NavCtaContext) ?? null
}
