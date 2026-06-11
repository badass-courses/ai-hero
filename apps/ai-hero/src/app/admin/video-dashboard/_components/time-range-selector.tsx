'use client'

import type { TimeRange } from '@/lib/mux-data'
import { Loader2 } from 'lucide-react'

const RANGES: { value: TimeRange; label: string }[] = [
	{ value: '7:days', label: '7d' },
	{ value: '30:days', label: '30d' },
	{ value: '90:days', label: '90d' },
]

export function TimeRangeSelector({
	current,
	isPending,
	onRangeChange,
}: {
	current: TimeRange
	isPending?: boolean
	onRangeChange: (range: TimeRange) => void
}) {
	return (
		<div className="flex items-center gap-2">
			{isPending && (
				<Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
			)}
			<div className="border-border/50 bg-muted/30 inline-flex items-center gap-0.5 rounded-lg border p-1">
				{RANGES.map(({ value, label }) => (
					<button
						key={value}
						onClick={() => onRangeChange(value)}
						disabled={isPending}
						className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
							current === value
								? 'bg-primary text-primary-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground hover:bg-muted'
						} ${isPending ? 'cursor-wait opacity-60' : ''}`}
					>
						{label}
					</button>
				))}
			</div>
		</div>
	)
}
