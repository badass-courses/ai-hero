'use client'

import * as React from 'react'
import { useMuxPlayer } from '@/hooks/use-mux-player'
import { api } from '@/trpc/react'

import { Label, Switch } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * Opt-in to Mux 480p. Off by default so the player keeps the 540p floor.
 * Lives on the profile page, not on lesson chrome.
 */
export function LowResolutionToggle({
	className,
	id = 'profile-low-resolution-toggle',
}: {
	className?: string
	id?: string
}) {
	const { playerPrefs, setPlayerPrefs } = useMuxPlayer()
	const utils = api.useUtils()
	const { mutate } = api.users.setPlaybackPrefs.useMutation({
		onMutate: async (input) => {
			await utils.users.getPlaybackPrefs.cancel()
			utils.users.getPlaybackPrefs.setData(undefined, {
				allowLowResolution: input.allowLowResolution,
				stored: true,
			})
			setPlayerPrefs({
				allowLowResolution: input.allowLowResolution,
			})
		},
	})

	const handleChange = React.useCallback(
		(checked: boolean) => {
			setPlayerPrefs({
				allowLowResolution: checked,
			})
			mutate({ allowLowResolution: checked })
		},
		[mutate, setPlayerPrefs],
	)

	return (
		<div className={cn('flex items-center gap-3', className)}>
			<Switch
				aria-label={`Allow 480p ${playerPrefs.allowLowResolution ? 'on' : 'off'}`}
				id={id}
				checked={playerPrefs.allowLowResolution}
				onCheckedChange={handleChange}
			/>
			<Label htmlFor={id} className="font-normal">
				Allow 480p
			</Label>
		</div>
	)
}
