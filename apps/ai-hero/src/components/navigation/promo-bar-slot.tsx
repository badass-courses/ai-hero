'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'

import { getNavMode } from './nav-mode'

/**
 * Route gate for the promo bar.
 *
 * `PromoBar` is an async server component mounted in the ROOT layout, so it had
 * no access to the nav-mode decision that strips marketing chrome from editor,
 * admin, auth and post-purchase routes — the nav honoured `minimal`, the promo
 * bar sat outside it and rendered everywhere. That put a cohort ad above the
 * admin dashboard, the login screen, and the page confirming someone had just
 * bought the thing being advertised.
 *
 * A client wrapper taking the bar as `children` is what lets a server component
 * be gated on a client-side path decision without making it dynamic:
 * `usePathname` also resolves during SSR, so the bar is absent from the server
 * HTML too — no flash of a promo that then disappears.
 *
 * The bar's own cached query still runs on these routes (it is resolved before
 * this renders). That is a cached read shared with every other route and not
 * worth restructuring the layout to avoid.
 */
export function PromoBarSlot({ children }: { children: React.ReactNode }) {
	const pathname = usePathname()
	if (getNavMode(pathname) === 'minimal') return null
	return <>{children}</>
}
