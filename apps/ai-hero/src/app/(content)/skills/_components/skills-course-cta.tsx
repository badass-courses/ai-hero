import Link from 'next/link'
import { ArrowRight, GraduationCap } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

export function SkillsCourseCta({
	className,
	compact = false,
}: {
	className?: string
	compact?: boolean
}) {
	return (
		<Link
			href="/skills/subscribe"
			aria-label="Start the free AI Skills for Real Engineers email course"
			className={cn(
				'not-prose border-primary/30 bg-primary/5 hover:bg-primary/10 group flex items-center gap-5 rounded-xl border p-6 no-underline transition sm:p-8',
				compact &&
					'h-full w-full flex-col items-start justify-center rounded-none border-0 bg-transparent px-8 py-10 sm:px-10',
				className,
			)}
		>
			<span className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-lg">
				<GraduationCap className="size-6" aria-hidden />
			</span>
			<div className="flex flex-1 flex-col gap-2">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
					Free 7-day email course
				</span>
				<h2
					className={cn(
						'text-foreground text-balance text-2xl font-semibold leading-tight',
						compact && 'text-xl',
					)}
				>
					AI Skills for Real Engineers
				</h2>
				<p className="text-foreground/70 text-balance text-sm leading-relaxed sm:text-base">
					Build a repeatable workflow for coding agents without giving up your
					engineering standards.
				</p>
			</div>
			<span className="bg-primary text-primary-foreground inline-flex shrink-0 items-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold transition group-hover:bg-primary/90">
				Start the course
				<ArrowRight
					className="size-4 transition-transform group-hover:translate-x-1"
					aria-hidden
				/>
			</span>
		</Link>
	)
}
