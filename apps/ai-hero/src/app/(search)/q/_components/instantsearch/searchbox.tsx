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
	const { refine, clear, isSearchStalled, ...rest } = useSearchBox(props)
	const [queryParam] = useQueryState('q')

	return (
		<div className="relative flex w-full items-center">
			<Input
				className={cn('my-3 h-9 bg-transparent pl-8 text-sm', props.className)}
				onChange={(event) => refine(event.currentTarget.value)}
				defaultValue={queryParam || ''}
				placeholder="Search..."
				{...rest}
			/>
			<Search className="text-muted-foreground absolute left-3 w-4" />
		</div>
	)
}
