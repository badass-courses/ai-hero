'use client'

import { useEffect, useState } from 'react'
import { getCheckboxState, setCheckboxState } from '@/utils/checkbox-storage'
import { cn } from '@coursebuilder/utils/cn'
import { Check } from 'lucide-react'

/**
 * Persistent checkbox for MDX content.
 * State is stored in browser IndexedDB and survives page refreshes.
 */
export function MDXCheckbox({
	lessonId,
	index,
	...props
}: {
	lessonId: string
	index: number
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked'>) {
	const checkboxId = `${lessonId}-checkbox-${index}`
	const [checked, setChecked] = useState(false)

	// Load state from IndexedDB on mount
	useEffect(() => {
		let mounted = true

		getCheckboxState(checkboxId).then((savedState) => {
			if (mounted && savedState !== null) {
				setChecked(savedState)
			}
		})

		return () => {
			mounted = false
		}
	}, [checkboxId])

	const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const newChecked = e.target.checked
		setChecked(newChecked)
		await setCheckboxState(checkboxId, newChecked)
	}

	return (
		// A span, not a label: the task-list row around it (`ah-task` in
		// compile-mdx) is the label, so the whole line toggles.
		<span className="group/checkbox relative mr-[0.4em] inline-flex cursor-pointer items-center justify-center align-[-0.2em]">
			<input
				{...props}
				type="checkbox"
				className={cn(
					// Sized in `em` so the circle tracks the body copy it sits in.
					'border-foreground/35 bg-background not-checked:hover:border-foreground/60 not-checked:[.ah-task:hover_&]:border-foreground/60 checked:border-primary checked:bg-primary focus-visible:ring-ring peer relative size-[1.125em] shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
				)}
				checked={checked}
				onChange={handleChange}
				disabled={false}
			/>
			<Check
				strokeWidth={3}
				className="peer-checked:text-primary-foreground text-foreground pointer-events-none absolute size-[0.7em] opacity-30 transition-opacity duration-150 group-hover/checkbox:opacity-60 [.ah-task:hover_&]:opacity-60 peer-checked:opacity-100"
			/>
		</span>
	)
}
