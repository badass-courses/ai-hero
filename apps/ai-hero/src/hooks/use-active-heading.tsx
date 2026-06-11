'use client'

import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
	type ReactNode,
} from 'react'

export interface HeadingInfo {
	slug: string
	text: string
	level: number
}

interface ActiveHeadingContextType {
	visibleHeadings: Map<string, HeadingInfo>
	registerVisibility: (heading: HeadingInfo, isVisible: boolean) => void
	activeHeadings: HeadingInfo[]
	activeHeading: HeadingInfo | null
	setActiveHeading: (heading: HeadingInfo | null) => void
}

const ActiveHeadingContext = createContext<ActiveHeadingContextType | null>(
	null,
)

export { ActiveHeadingContext }

interface ActiveHeadingProviderProps {
	children: ReactNode
}

export function ActiveHeadingProvider({
	children,
}: ActiveHeadingProviderProps) {
	const [visibleHeadings, setVisibleHeadings] = useState<
		Map<string, HeadingInfo>
	>(() => new Map())

	const registerVisibility = useCallback(
		(heading: HeadingInfo, isVisible: boolean) => {
			setVisibleHeadings((current) => {
				const alreadyTracked = current.has(heading.slug)
				if (isVisible && alreadyTracked) return current
				if (!isVisible && !alreadyTracked) return current

				const next = new Map(current)
				if (isVisible) {
					next.set(heading.slug, heading)
				} else {
					next.delete(heading.slug)
				}
				return next
			})
		},
		[],
	)

	const setActiveHeading = useCallback((heading: HeadingInfo | null) => {
		setVisibleHeadings(heading ? new Map([[heading.slug, heading]]) : new Map())
	}, [])

	const activeHeadings = useMemo(
		() => Array.from(visibleHeadings.values()),
		[visibleHeadings],
	)

	const activeHeading = useMemo<HeadingInfo | null>(() => {
		if (visibleHeadings.size === 0) return null
		const headings = Array.from(visibleHeadings.values())
		return headings[headings.length - 1] ?? null
	}, [visibleHeadings])

	const contextValue = useMemo(
		() => ({
			visibleHeadings,
			registerVisibility,
			activeHeadings,
			activeHeading,
			setActiveHeading,
		}),
		[
			visibleHeadings,
			registerVisibility,
			activeHeadings,
			activeHeading,
			setActiveHeading,
		],
	)

	return (
		<ActiveHeadingContext.Provider value={contextValue}>
			{children}
		</ActiveHeadingContext.Provider>
	)
}

export function useActiveHeadingContext() {
	const context = useContext(ActiveHeadingContext)

	if (!context) {
		throw new Error(
			'useActiveHeadingContext must be used within an ActiveHeadingProvider',
		)
	}

	return context
}
