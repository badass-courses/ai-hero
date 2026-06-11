import * as React from 'react'

import { CompactCountdown } from './compact-countdown'

export function DiscountBadge({
	percentageOff,
	expires,
}: {
	percentageOff: number
	expires?: string | Date | null
}) {
	return (
		<span className="bg-foreground text-background inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider">
			<span>{percentageOff}% OFF</span>
			{expires && (
				<>
					<span aria-hidden>·</span>
					<CompactCountdown expires={expires} />
				</>
			)}
		</span>
	)
}
