'use client'

import * as React from 'react'
import { cn } from '@coursebuilder/ui/utils/cn'

import { AutoPlayToggle } from './autoplay-toggle'
import { LowResolutionToggle } from './low-resolution-toggle'

/**
 * Autoplay plus the 480p opt-in, stacked for player chrome and the lesson sidebar.
 */
export function PlayerPrefToggles({
	className,
	toggleClassName,
	idPrefix = 'player-prefs',
}: {
	className?: string
	toggleClassName?: string
	idPrefix?: string
}) {
	return (
		<div className={cn('flex flex-col items-start gap-2', className)}>
			<AutoPlayToggle
				id={`${idPrefix}-autoplay`}
				className={toggleClassName}
			/>
			<LowResolutionToggle
				id={`${idPrefix}-low-resolution`}
				className={toggleClassName}
			/>
		</div>
	)
}
