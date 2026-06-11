import React from 'react'

import { cn } from '@coursebuilder/ui/utils/cn'

function CalloutIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
		>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="1.5"
				d="M12.31 3h-.62c-2.436 0-3.654 0-4.65.553-.997.552-1.588 1.555-2.771 3.562l-.59 1C2.56 10.014 2 10.963 2 12s.56 1.986 1.68 3.885l.589 1c1.183 2.007 1.774 3.01 2.77 3.563.997.552 2.215.552 4.65.552h.622c2.435 0 3.653 0 4.65-.552.996-.553 1.587-1.556 2.77-3.563l.59-1C21.44 13.986 22 13.037 22 12s-.56-1.986-1.68-3.885l-.589-1c-1.183-2.007-1.774-3.01-2.77-3.562C15.963 3 14.745 3 12.31 3Z"
			/>
		</svg>
	)
}

export function Callout({
	children,
	className,
	icon,
}: {
	children: React.ReactNode
	className?: string
	icon?: React.ReactNode
}) {
	return (
		<div
			className={cn(
				'not-prose bg-card shadow-md/3 my-3 flex items-stretch gap-4 rounded-xl border',
				className,
			)}
		>
			<div className="text-primary bg-stripes flex shrink-0 items-center justify-center overflow-hidden rounded-l-xl border-r px-5 py-4">
				{icon ?? <CalloutIcon className="size-4 shrink-0" />}
			</div>
			<div className="prose prose-sm sm:prose-base dark:prose-invert prose-p:my-0 py-4 pr-5">
				{children}
			</div>
		</div>
	)
}
