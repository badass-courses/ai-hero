import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

export type CommandCardProps = {
	/** The slash command as the reader would type it, e.g. `/grill-me`. */
	command: string
	/** Optional trailing gloss, e.g. "runs before you open a PR". */
	note?: string
	/** Lead-in eyebrow. The spec's default copy is "Do this with". */
	label?: string
	/** Where the command lives. Without it the card is a statement, not a link. */
	href?: string
	className?: string
}

/**
 * The dashed "Do this with /command" card from the learn map.
 *
 * Dashed rather than solid on purpose: solid hairline boxes on this site are
 * structure (rows, cells, panels), and this is an aside pointing sideways at
 * something you can run. The dash is what stops it reading as another row in
 * whatever list it lands in.
 *
 * The command takes `text-primary`, which is gold in dark and ink in light —
 * exactly the spec's rule that this card is neutral ink on paper and never a
 * darkened yellow (DESIGN rule 7). Do not reach for `--accent-fill` here; it
 * would put brown type on a light background.
 *
 * Unlike `SkillCard`, nothing here is resolved from the CMS: the copy is what
 * the author typed. That makes it usable for commands with no published skill
 * post behind them, and mid-article where a full card would be too loud.
 */
export function CommandCard({
	command,
	note,
	label = 'Do this with',
	href,
	className,
}: CommandCardProps) {
	const content = (
		<>
			{label ? (
				<span
					className={cn(
						TYPE.metaMark,
						'flex-none dark:text-primary/75',
					)}
				>
					{label}
				</span>
			) : null}
			<span
				className={cn(TYPE.meta, 'text-primary min-w-0 truncate font-mono')}
			>
				{command}
			</span>
			{note ? (
				<span
					className={cn(
						TYPE.metaProse,
						// At narrow widths the note drops to its own line rather than
						// squeezing the command, which is the one token worth reading.
						'order-last w-full min-w-0 text-[color:var(--ah-fg-muted)] sm:order-none sm:w-auto',
					)}
				>
					{note}
				</span>
			) : null}
			<ArrowRight
				aria-hidden
				className={cn(
					'ml-auto size-4 flex-none text-[color:var(--ah-fg-subtle)] dark:text-primary',
					href &&
						'ease-out-quart transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none',
				)}
			/>
		</>
	)

	const shell = cn(
		'not-prose my-6 flex w-full flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-[9px] border border-dashed border-[color:var(--ah-accent-line)] bg-[color:var(--ah-accent-wash)] px-4 py-3',
		className,
	)

	if (!href) {
		return <div className={shell}>{content}</div>
	}

	return (
		<Link
			href={href}
			className={cn(
				shell,
				'focus-visible:ring-ring group transition-colors hover:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
			)}
		>
			{content}
		</Link>
	)
}
