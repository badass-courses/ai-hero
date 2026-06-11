import * as React from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

export function DictionaryTile({
	title,
	description,
	href,
	sectionLabel,
}: {
	title: string
	description?: string
	href: string
	sectionLabel?: string
}) {
	return (
		<Link
			href={href}
			prefetch={false}
			className="bg-background hover:bg-muted/40 group relative flex h-full flex-col gap-3 p-6 transition-colors sm:p-7"
		>
			{sectionLabel ? (
				<span className="font-mono text-[10px] font-medium uppercase tracking-wider opacity-60">
					{sectionLabel}
				</span>
			) : null}
			<div className="flex items-start justify-between gap-3">
				<h3 className="text-lg font-semibold leading-tight tracking-tight sm:text-xl">
					{title}
				</h3>
				<ArrowUpRight
					aria-hidden
					className="text-muted-foreground size-4 shrink-0 translate-y-0.5 transition-all duration-200 ease-out group-hover:-translate-y-0 group-hover:translate-x-0.5 group-hover:text-foreground"
				/>
			</div>
			{description ? (
				<p className="text-muted-foreground line-clamp-3 text-sm leading-relaxed">
					{description}
				</p>
			) : null}
		</Link>
	)
}
