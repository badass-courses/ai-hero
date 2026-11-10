'use client'

import React from 'react'
import { Search } from 'lucide-react'
import { useQueryState } from 'nuqs'
import type { SearchBoxProps } from 'react-instantsearch'
import { useSearchBox } from 'react-instantsearch'

import { Input } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

export const SearchBox = (
	props: SearchBoxProps & {
		className?: string
	},
) => {
	const pending = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const pendingSearch = React.useRef<(() => void) | null>(null)
	const cancelPending = React.useCallback(() => {
		clearTimeout(pending.current)
		pendingSearch.current = null
	}, [])
	const flushPending = () => {
		const search = pendingSearch.current
		cancelPending()
		search?.()
	}
	const queryHook = React.useCallback(
		(query: string, search: (value: string) => void) => {
			cancelPending()
			if (query === '') {
				search(query)
				return
			}
			pendingSearch.current = () => search(query)
			pending.current = setTimeout(() => {
				pendingSearch.current = null
				search(query)
			}, 300)
		},
		[cancelPending],
	)
	React.useEffect(() => cancelPending, [cancelPending])

	const { refine, clear, isSearchStalled, ...rest } = useSearchBox({
		...props,
		queryHook,
	})
	const [queryParam] = useQueryState('q')

	return (
		<form
			className="relative flex w-full items-center"
			onSubmit={(event) => {
				event.preventDefault()
				flushPending()
			}}
		>
			<Input
				className={cn('my-3 h-9 bg-transparent pl-8 text-sm', props.className)}
				onChange={(event) => refine(event.currentTarget.value)}
				defaultValue={queryParam || ''}
				placeholder="Search..."
				{...rest}
			/>
			<Search className="text-muted-foreground absolute left-3 w-4" />
		</form>
	)
}
