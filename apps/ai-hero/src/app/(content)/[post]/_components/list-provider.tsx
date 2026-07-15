'use client'

import React from 'react'
import type { List } from '@/lib/lists'

interface ListContextType {
	list: List | null
	isLoading: boolean
	currentPostHasVideo: boolean
}

const ListContext = React.createContext<ListContextType>({
	list: null,
	isLoading: false,
	currentPostHasVideo: false,
})

/**
 * ListProvider exposes the current post's list (the module/tutorial it belongs
 * to, resolved server-side by DB membership) to descendant client components
 * (`useList`).
 *
 * The former `?list=` query-param override (fetching a different list client
 * side) was removed 2026-07-06 — nothing links with `?list=` anymore, so the
 * list is simply whatever the server passed as `initialList`.
 *
 * @param initialList - The list data fetched server-side during initial page load
 * @param children - React child components that will have access to list context
 */
export function ListProvider({
	initialList,
	currentPostHasVideo = false,
	children,
}: {
	initialList: List | null
	currentPostHasVideo?: boolean
	children: React.ReactNode
}) {
	return (
		<ListContext.Provider
			value={{ list: initialList, isLoading: false, currentPostHasVideo }}
		>
			{children}
		</ListContext.Provider>
	)
}

export function useList() {
	return React.useContext(ListContext)
}
