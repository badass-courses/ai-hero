import Link from 'next/link'

import { cn } from '@coursebuilder/utils/cn'

/**
 * On-brand placeholder for navigation-redesign destinations whose real content
 * lands in a later phase (see `plans/navigation-redesign.md`). Keeps every nav
 * link resolving to a real page instead of a 404 while pages are built out.
 */
export function ComingSoon({
	label,
	title,
	description,
	className,
}: {
	/** Mono micro-label above the title. */
	label: string
	title: string
	description: string
	className?: string
}) {
	return (
		<main
			className={cn(
				'flex min-h-[calc(100vh-var(--nav-height))] flex-col items-center justify-center',
				className,
			)}
		>
			<div className="flex w-full max-w-2xl flex-col items-center gap-4 px-8 py-24 text-center sm:px-16">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					{label}
				</p>
				<h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
					{title}
				</h1>
				<p className="max-w-prose text-balance text-base leading-relaxed opacity-80 sm:text-lg">
					{description}
				</p>
				<Link
					href="/posts"
					className="focus-visible:ring-ring mt-2 inline-flex items-center font-mono text-sm underline underline-offset-4 opacity-80 transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					Browse all posts
				</Link>
			</div>
		</main>
	)
}
