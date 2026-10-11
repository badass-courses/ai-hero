'use client'

import * as React from 'react'
import { createPurchaseWaitLogger } from './post-purchase-telemetry'

/** Focus the real destination heading, never a loading placeholder. */
export function PostPurchaseArrival({
	destination,
	checkoutSessionId,
	purchaseWasPolled = false,
}: {
	destination: 'welcome' | 'login_link'
	checkoutSessionId?: string
	purchaseWasPolled?: boolean
}) {
	const marker = React.useRef<HTMLSpanElement>(null)
	const logger = React.useMemo(
		() =>
			checkoutSessionId
				? createPurchaseWaitLogger(checkoutSessionId)
				: undefined,
		[checkoutSessionId],
	)
	React.useEffect(() => {
		const heading = marker.current?.parentElement?.querySelector('h1')
		if (heading instanceof HTMLElement) {
			heading.tabIndex = -1
			heading.focus({ preventScroll: true })
		}
		// Fast webhook: no poller mounted, so record the two observed steps here.
		if (!purchaseWasPolled) {
			logger?.('client_returned')
			logger?.('purchase_visible')
		}
		logger?.('destination_rendered')
	}, [destination, logger, purchaseWasPolled])
	return <span ref={marker} hidden />
}
