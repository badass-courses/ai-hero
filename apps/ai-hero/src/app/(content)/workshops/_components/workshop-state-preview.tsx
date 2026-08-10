'use client'

/**
 * DEV-ONLY workshop landing state switcher. Not production code — a local
 * fixture for flipping the page between its states (waitlist, pricing,
 * purchased, in-progress, …) while designing/screenshotting. Wired up in
 * `[module]/page.tsx` behind NODE_ENV === 'development'; do not ship.
 */
import Link from 'next/link'

import { cn } from '@coursebuilder/ui/utils/cn'

import {
	WORKSHOP_PREVIEW_STATES,
	type WorkshopPreviewState,
} from './workshop-state-preview-shared'

export function WorkshopStatePreviewBar({
	moduleSlug,
	current,
}: {
	moduleSlug: string
	current?: WorkshopPreviewState
}) {
	if (process.env.NODE_ENV !== 'development') return null

	const pathname = `/workshops/${moduleSlug}`

	return (
		<div className="bg-card/95 fixed bottom-4 left-4 z-[60] hidden items-center gap-1 rounded-lg border p-1 font-mono text-[11px] shadow-lg backdrop-blur md:flex">
			<span className="text-muted-foreground px-1.5 uppercase tracking-wider">
				state
			</span>
			<Link
				href={pathname}
				scroll={false}
				className={cn(
					'rounded px-2 py-1 transition-colors',
					!current
						? 'bg-foreground text-background'
						: 'hover:bg-muted text-muted-foreground',
				)}
			>
				live
			</Link>
			{WORKSHOP_PREVIEW_STATES.map((state) => (
				<Link
					key={state}
					href={{ pathname, query: { state } }}
					scroll={false}
					className={cn(
						'rounded px-2 py-1 transition-colors',
						current === state
							? 'bg-foreground text-background'
							: 'hover:bg-muted text-muted-foreground',
					)}
				>
					{state}
				</Link>
			))}
		</div>
	)
}
