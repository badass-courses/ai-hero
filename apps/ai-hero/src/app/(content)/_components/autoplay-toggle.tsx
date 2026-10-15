'use client'

import { useMuxPlayer } from '@/hooks/use-mux-player'

import { Label, Switch } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

export function AutoPlayToggle({
	className,
	id = 'autoplay-toggle',
}: {
	className?: string
	/** Unique per instance — the toggle can render both under the video and in the player chrome. */
	id?: string
}) {
	const { playerPrefs, setPlayerPrefs } = useMuxPlayer()

	return (
		<div className={cn('flex items-center gap-2', className)}>
			<Switch
				className={cn('')}
				aria-label={`Turn Autoplay ${playerPrefs.autoplay ? 'off' : 'on'}`}
				id={id}
				checked={playerPrefs.autoplay}
				// Only the preference: autoplay decides what happens when a video
				// ends, so flipping it must not play or pause the current one.
				onCheckedChange={(checked) => setPlayerPrefs({ autoplay: checked })}
			/>
			<Label htmlFor={id}>Autoplay</Label>
		</div>
	)
}
