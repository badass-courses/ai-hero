'use client'

import { useEffect } from 'react'

/** One fixed-page notification, not a client event stream. The server owns
 * sign-in, the flag, contact resolution and all drovr credentials/payloads.
 */
export function ProductPageView() {
	useEffect(() => {
		void fetch('/api/product-events/team-page-view', {
			method: 'POST',
			credentials: 'same-origin',
			keepalive: true,
		}).catch(() => {
			/* Tracking never affects navigation. */
		})
	}, [])
	return null
}
