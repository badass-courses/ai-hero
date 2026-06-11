import React from 'react'

function DefaultIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
		>
			<circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5" />
		</svg>
	)
}

export function Timeline({ children }: { children: React.ReactNode }) {
	return (
		<div className="my-6">
			<div className="relative space-y-0">
				{/* Vertical line from first circle center to last circle center */}
				<div className="dark:bg-foreground/10 bg-border absolute bottom-[30px] left-[19px] top-[30px] w-px" />
				{children}
			</div>
		</div>
	)
}

export function TimelineItem({
	children,
	icon,
}: {
	children: React.ReactNode
	icon?: React.ReactNode
}) {
	return (
		<div className="relative flex gap-4 pb-6 last:pb-0">
			<div className="bg-card border-border z-10 flex size-10 shrink-0 items-center justify-center rounded-full border-2">
				<div className="text-muted-foreground [&>svg]:size-6">
					{icon ?? <DefaultIcon className="size-6" />}
				</div>
			</div>
			<div
				className="prose-p:m-0 pt-1.5 sm:pt-1"
				// className="prose prose-sm sm:prose-base lg:prose-lg dark:prose-invert pt-1"
			>
				{children}
			</div>
		</div>
	)
}
