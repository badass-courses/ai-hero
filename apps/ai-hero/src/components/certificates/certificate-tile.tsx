import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { Lock } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

/** The Get Certificate button a tile shows once the certificate is earned. */
export const CERTIFICATE_TILE_ACTION = cn(
	TYPE.meta,
	'border-border text-foreground hover:bg-hover mt-0.5 h-10 w-full cursor-pointer rounded-[9px] border bg-transparent',
)

/**
 * The certificate as a progress tile (`Workshop Landing.dc.html` § Sidebar,
 * purchased state): title with a lock while it's earned, a hairline progress
 * bar, and the completed count in mono. It replaces the certificate-shaped
 * placard — a drawing of the reward where the sidebar needs a report of the
 * distance to it. Unlocking swaps the lock for the Get Certificate action.
 *
 * A workshop and a cohort show the same tile: each brings its own count and,
 * once earned, its own trigger as `action`.
 */
export function CertificateTile({
	completedCount,
	totalCount,
	percent,
	progressLabel,
	action,
}: {
	/** Lessons done and in all. Absent while the count is still loading. */
	completedCount?: number
	totalCount?: number
	percent: number
	/** Names the bar for assistive tech, e.g. "Workshop progress". */
	progressLabel: string
	/** The Get Certificate trigger. Without one the tile is locked. */
	action?: React.ReactNode
}) {
	const counted = completedCount !== undefined && totalCount !== undefined

	return (
		<div className="border-border flex flex-col gap-2.5 rounded-[11px] border p-4">
			<div className="flex items-center justify-between gap-2.5">
				<div className={cn(TYPE.meta, 'font-bold tracking-[-0.018em]')}>
					Certificate of Completion
				</div>
				{action ? null : (
					<Lock
						className="text-muted-foreground size-3.5 shrink-0"
						aria-label="Locked until every lesson is complete"
					/>
				)}
			</div>
			<div
				className="bg-foreground/10 h-[3px] overflow-hidden rounded-[4px]"
				role="progressbar"
				aria-valuenow={percent}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={progressLabel}
			>
				<div className="bg-accent-fill h-full" style={{ width: `${percent}%` }} />
			</div>
			{/* The line keeps its height while the count loads, so the tile does
			    not grow when it arrives. */}
			<div className={cn(TYPE.metaMark)} aria-hidden={counted ? undefined : true}>
				{counted
					? `${completedCount}/${totalCount} lessons completed`
					: ' '}
			</div>
			{action}
		</div>
	)
}
