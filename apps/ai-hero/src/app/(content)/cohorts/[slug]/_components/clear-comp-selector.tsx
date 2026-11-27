'use client'

import { useLayoutEffect } from 'react'
import { inSelectorNamespace } from '@/lib/coupon-batches/namespace'

/** The rendered claim dialog already has its selector. Don't keep it in history. */
export function ClearCompSelector() {
	useLayoutEffect(() => {
		const url = new URL(window.location.href)
		if (!url.searchParams.getAll('code').some(inSelectorNamespace)) return
		url.searchParams.delete('code')
		window.history.replaceState(window.history.state, '', url)
	}, [])
	return null
}
