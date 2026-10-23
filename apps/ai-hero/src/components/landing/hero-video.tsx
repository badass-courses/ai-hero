'use client'

import * as React from 'react'
import MuxPlayer from '@mux/mux-player-react'

import { Dialog, DialogContent, DialogTrigger } from '@coursebuilder/ui'

export function HeroVideo({
	playbackId,
	title,
}: {
	playbackId: string
	title?: string
}) {
	const [open, setOpen] = React.useState(false)
	const previewRef = React.useRef<React.ComponentRef<typeof MuxPlayer>>(null)

	return (
		<Dialog open={open} onOpenChange={setOpen} modal={false}>
			<DialogTrigger asChild>
				<button
					type="button"
					aria-label={title ? `Play ${title}` : 'Play welcome video'}
					className="group relative block h-full min-h-80 w-full cursor-pointer overflow-hidden"
				>
					<MuxPlayer
						ref={previewRef}
						playbackId={playbackId}
						streamType="on-demand"
						autoPlay="muted"
						muted
						loop
						playsInline
						preload="auto"
						nohotkeys
						defaultHiddenCaptions
						className="pointer-events-none absolute inset-0 h-full w-full [--controls:none] [--media-object-fit:cover] [--media-object-position:center]"
					/>
					<div
						aria-hidden
						className="from-background via-background/0 to-background pointer-events-none absolute inset-0 bg-gradient-to-r"
					/>
					<div
						aria-hidden
						className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t to-transparent"
					/>
					<div
						aria-hidden
						className="from-background pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b to-transparent"
					/>
					<span className="border-foreground/30 bg-background/40 group-hover:bg-background/60 absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border backdrop-blur transition group-hover:scale-105">
						<svg
							viewBox="0 0 24 24"
							className="fill-foreground h-7 w-7"
							aria-hidden
						>
							<path d="M8 5v14l11-7z" />
						</svg>
					</span>
				</button>
			</DialogTrigger>
			<DialogContent className="bg-background h-[min(75vh,calc(85vw*9/16))] w-[min(85vw,calc(75vh*16/9))] max-w-none border-0 p-0 sm:max-w-none">
				<MuxPlayer
					playbackId={playbackId}
					streamType="on-demand"
					title={title}
					autoPlay
					accentColor="#ffcf77"
					className="h-full w-full"
				/>
			</DialogContent>
		</Dialog>
	)
}
