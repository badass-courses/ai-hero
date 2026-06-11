'use client'

import * as React from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useSortBy } from 'react-instantsearch'

import {
	Button,
	Command,
	CommandGroup,
	CommandItem,
	CommandList,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

import { sortOptions } from './sort-options'

export { sortOptions }

export function SortBy() {
	const { refine, currentRefinement } = useSortBy({
		items: sortOptions,
	})
	const [open, setOpen] = React.useState(false)

	const currentLabel = sortOptions.find(
		(option) => option.value === currentRefinement,
	)?.label

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					role="combobox"
					aria-expanded={open}
					className="w-full justify-between bg-transparent"
				>
					<span
						className={cn('truncate text-sm font-normal', {
							'text-muted-foreground': !currentLabel,
						})}
					>
						{currentLabel ?? 'Sort by...'}
					</span>
					<ChevronsUpDown className="opacity-50" size={16} />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[200px] p-0">
				<Command>
					<CommandList>
						<CommandGroup>
							{sortOptions.map((option) => {
								const isSelected = currentRefinement === option.value

								return (
									<CommandItem
										key={option.value}
										value={option.value}
										onSelect={() => {
											refine(option.value)
											setOpen(false)
										}}
									>
										{option.label}
										<Check
											className={cn('ml-auto', {
												'opacity-100': isSelected,
												'opacity-0': !isSelected,
											})}
										/>
									</CommandItem>
								)
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}
