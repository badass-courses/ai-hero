'use client'

import * as React from 'react'
import { useMuxPlayer } from '@/hooks/use-mux-player'

import { Label, Switch } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * Opt-in to Mux 480p. Off by default so the player keeps the 540p floor.
 */
export function LowResolutionToggle({
	className,
	id = 'low-resolution-toggle',
}: {
	className?: string
	/** Unique per instance — the toggle can render in the sidebar and in player chrome. */
	id?: string
}) {
	const { playerPrefs, setPlayerPrefs } = useMuxPlayer()

	const handleChange = React.useCallback(
		(checked: boolean) => {
			setPlayerPrefs({
				allowLowResolution: checked,
			})
		},
		[setPlayerPrefs],
	)

	return (
		<div className={cn('flex items-center gap-2', className)}>
			<Switch
				aria-label={`Allow 480p ${playerPrefs.allowLowResolution ? 'on' : 'off'}`}
				id={id}
				checked={playerPrefs.allowLowResolution}
				onCheckedChange={handleChange}
			/>
			<Label htmlFor={id}>Allow 480p</Label>
		</div>
	)
}
