'use client'

import * as React from 'react'
import type { CohortOffer } from '@/lib/nav-cta'

/**
 * Carries the server-resolved {@link CohortOffer} down to `Navigation`.
 *
 * Context rather than a prop because `Navigation` is rendered inside
 * `LayoutClient`, itself a client component with ~80 call sites — threading a
 * prop would mean touching every page. The root layout is a server component,
 * so it can resolve the offer and hand it over here.
 *
 * It carries a PROMISE, not a value. The root layout renders above every page
 * on the site, so awaiting the offer there held the whole document — the `html`
 * tag included — behind one database read, for a value that feeds a nav button
 * and an announcement bar. Handing the unresolved promise across the boundary
 * lets the shell stream immediately; the two components that actually want the
 * offer unwrap it with `use()` behind their own `Suspense`.
 *
 * `getCohortOfferSafe` catches its own failures and resolves to `null`, so this
 * promise never rejects and no error boundary is needed for it.
 *
 * `null` is a real answer ("no cohort exists"), so the default is `undefined`
 * to keep "provider missing" distinguishable.
 */
type CohortOfferPromise = Promise<CohortOffer | null>

const NavCtaContext = React.createContext<CohortOfferPromise | undefined>(
	undefined,
)

export function NavCtaProvider({
	value,
	children,
}: {
	value: CohortOfferPromise
	children: React.ReactNode
}) {
	return <NavCtaContext.Provider value={value}>{children}</NavCtaContext.Provider>
}

/**
 * SUSPENDS until the offer resolves. Every caller must sit under a `Suspense`
 * boundary whose fallback is acceptable for the length of one cached DB read —
 * in practice `null`, since both call sites are optional chrome.
 */
export function useCohortOffer(): CohortOffer | null {
	const promise = React.useContext(NavCtaContext)
	return promise ? React.use(promise) : null
}
