import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import type { LibraryEntry } from '@/lib/library-query'
import { ArrowRight, Check } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The courses this account owns, each with the way back into it.
 *
 * The rows used to say "Open course" and lead to the sales page for something
 * already bought. The card's whole job now is the primary action: it names the
 * lesson the learner lands on, so the decision is made before the click.
 */
export function LibrarySection({ entries }: { entries: LibraryEntry[] }) {
	return (
		<section>
			<div className="mb-4">
				{/* Matches the page's own `h1`, which is 20px here — a section head
				    that outranks the page title reads as the wrong hierarchy. */}
				<h2 className={cn(TYPE.subhead)}>Your courses</h2>
				<p className={cn(TYPE.metaProse, 'text-muted-foreground')}>
					Everything connected to this account, and where you left off.
				</p>
			</div>

			{entries.length > 0 ? (
				<ul className="border-border bg-border grid gap-px border">
					{entries.map((entry) => (
						<li key={entry.key} className="bg-card">
							<LibraryCard entry={entry} />
						</li>
					))}
				</ul>
			) : (
				<div
					className={cn(
						TYPE.metaProse,
						'text-muted-foreground border-input rounded-[6px] border border-dashed p-4',
					)}
				>
					No courses on this account yet.
				</div>
			)}
		</section>
	)
}

function LibraryCard({ entry }: { entry: LibraryEntry }) {
	const isComplete = entry.status === 'complete'
	const hasProgress = entry.totalLessons > 0

	return (
		<div className="flex flex-col gap-4 p-5">
			<div className="flex min-w-0 flex-col gap-1">
				{entry.contextLabel && (
					<span className={cn(TYPE.metaMark, 'truncate')}>
						{entry.contextLabel}
					</span>
				)}
				<Link
					href={entry.href}
					className={cn(TYPE.cardTitle, 'hover:underline')}
				>
					{entry.title}
				</Link>
			</div>

			{hasProgress && (
				<div className="flex flex-col gap-2">
					{/* A bar and a count say the same thing twice on purpose: the bar is
					    scannable down a column of cards, the count is the fact. */}
					<div
						className="bg-foreground/10 h-1 w-full overflow-hidden rounded-full"
						role="img"
						aria-label={`${entry.completedLessons} of ${entry.totalLessons} lessons complete`}
					>
						{/* Nothing started draws nothing. A minimum-width nub would read
						    as "you have made a little progress", which is a lie. */}
						{entry.percent > 0 && (
							<div
								className={cn(
									'h-full rounded-full',
									isComplete ? 'bg-foreground/40' : 'bg-accent-fill',
								)}
								style={{ width: `${Math.max(entry.percent, 2)}%` }}
							/>
						)}
					</div>
					<span
						className={cn(TYPE.metaMark, 'flex items-center gap-1.5')}
						aria-hidden="true"
					>
						{isComplete && <Check className="size-3.5 shrink-0" />}
						{isComplete
							? 'Complete'
							: `${entry.completedLessons} of ${entry.totalLessons} lessons`}
					</span>
				</div>
			)}

			{entry.cta && (
				<Link
					href={entry.cta.href}
					className={cn(
						TYPE.meta,
						isComplete
							? 'text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 self-start underline underline-offset-4 transition-colors'
							: 'bg-accent-fill text-accent-fill-foreground inline-flex items-center gap-2 self-start rounded-[6px] px-3.5 py-2 transition hover:opacity-90',
					)}
				>
					<span className="truncate">{entry.cta.label}</span>
					{!isComplete && (
						<ArrowRight className="size-4 shrink-0" aria-hidden="true" />
					)}
				</Link>
			)}
		</div>
	)
}
