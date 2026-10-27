'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'

import { DialogOverlay, DialogPortal } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

function subscribe(onChange: () => void) {
	document.addEventListener('fullscreenchange', onChange)
	return () => document.removeEventListener('fullscreenchange', onChange)
}

/**
 * `DialogContent` from `@coursebuilder/ui`, portalled into the fullscreen
 * element when there is one. Only that element's subtree is drawn in
 * fullscreen, so a dialog opened from the player's end card would otherwise
 * open invisibly in `body`. The ui package's content takes no portal
 * container, hence the copy of its markup.
 */
export function FullscreenDialogContent({
	className,
	children,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
	const fullscreenElement = React.useSyncExternalStore(
		subscribe,
		() => document.fullscreenElement,
		() => null,
	)

	return (
		<DialogPortal container={fullscreenElement ?? undefined}>
			<DialogOverlay />
			<DialogPrimitive.Content
				className={cn(
					'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-[50%] top-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg',
					className,
				)}
				{...props}
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				{children}
				<DialogPrimitive.Close className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground rounded-xs focus:outline-hidden absolute right-4 top-4 opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0">
					<XIcon />
					<span className="sr-only">Close</span>
				</DialogPrimitive.Close>
			</DialogPrimitive.Content>
		</DialogPortal>
	)
}
