'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { api } from '@/trpc/react'
import { useSession } from 'next-auth/react'

import { getNavMode } from './nav-mode'
import { PromoBarContent } from './promo-bar-content'

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
 *
 * A signed-in reader with a seat waiting for them gets that instead of the
 * promo, in the same row: the invitation email's button works once, and this
 * is the way back to the transfer from anywhere on the site. It swaps in after
 * load, in a row of the same height, so nothing below it moves. The transfer
 * page is where it gets accepted, so the next page after it asks again.
 */
export function PromoBarSlot({ children }: { children: React.ReactNode }) {
	const pathname = usePathname()
	const minimal = getNavMode(pathname) === 'minimal'
	const { status } = useSession()
	const utils = api.useUtils()
	const { data: transfer } = api.users.incomingTransfer.useQuery(undefined, {
		enabled: status === 'authenticated' && !minimal,
		staleTime: 5 * 60 * 1000,
	})
	React.useEffect(() => {
		if (pathname.startsWith('/transfer/'))
			void utils.users.incomingTransfer.invalidate()
	}, [pathname, utils])
	if (minimal) return null
	if (transfer)
		return (
			<PromoBarContent
				promo={{
					label: 'For you',
					message: `A seat in ${transfer.productName ?? 'AI Hero'} is waiting for you`,
					href: `/transfer/${transfer.id}`,
				}}
			/>
		)
	return <>{children}</>
}
