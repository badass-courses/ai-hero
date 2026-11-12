'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { Check, ChevronDown } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import type { PrerequisitesViewProps } from './types'

type Item = PrerequisitesViewProps['items'][number]

/**
 * Compact list: one raised surface, a header that is also the hide/show
 * control, and one row per lesson. The list folds with a grid-rows
 * transition, so the collapsed one-liner is the same header with the rows
 * tucked away rather than a different component swapped in.
 */
export function PrerequisitesRows({
	title,
	level,
	items,
	completedCount,
	allCompleted,
	progressKnown,
	collapsed,
	onCollapsedChange,
}: PrerequisitesViewProps) {
	const listId = React.useId()
	const Heading = `h${level}` as const
	const done = progressKnown && allCompleted
	// The first lesson still to watch. Only a known, unfinished list has one;
	// unknown progress never claims a next step.
	const nextIndex =
		progressKnown && !allCompleted
			? items.findIndex((item) => !item.completed)
			: -1

	return (
		<div
			className={cn(
				'not-prose bg-card my-8 overflow-hidden rounded-lg border border-[color:var(--ah-line-strong)] dark:bg-[color-mix(in_oklch,var(--card),white_3.5%)]',
				'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_16px_-8px_rgb(0_0_0/0.10)]',
				'dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_8px_24px_-12px_rgb(0_0_0/0.8)]',
			)}
		>
			{/* The authored heading stays a heading for screen readers and
			    heading navigation. It wraps the toggle (the accordion pattern):
			    a heading cannot sit inside a button. Reset to inherit so the
			    global h1-h6 rule changes nothing visually. */}
			<Heading className="m-0 text-[length:inherit] leading-[inherit] font-[inherit] font-normal">
				<button
					type="button"
					aria-expanded={!collapsed}
					aria-controls={listId}
					onClick={() => onCollapsedChange(!collapsed)}
					className={cn(
						'group/head flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left sm:px-5',
						'transition-colors duration-200 hover:bg-[color:var(--ah-hover)]/60 active:bg-[color:var(--ah-hover)]',
						'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
					)}
				>
					{done ? (
						<span
							aria-hidden
							className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--ah-mark-yes)] text-[color:var(--card)]"
						>
							<Check className="size-3" strokeWidth={3} />
						</span>
					) : null}
					<span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
						<span className="text-foreground text-[15px] leading-[1.3] font-bold tracking-[-0.015em]">
							{title}
						</span>
						<span className={cn(TYPE.metaMark, 'tabular-nums')}>
							{progressKnown
								? `${completedCount} of ${items.length} done`
								: `${items.length} ${items.length === 1 ? 'lesson' : 'lessons'}`}
						</span>
					</span>
					{progressKnown && !done ? (
						<Segments total={items.length} completed={completedCount} />
					) : null}
					<span
						className={cn(
							TYPE.metaMark,
							'group-hover/head:text-foreground flex shrink-0 items-center gap-1 transition-colors',
						)}
					>
						<span className="hidden sm:inline">{collapsed ? 'Show' : 'Hide'}</span>
						<ChevronDown
							aria-hidden
							className={cn(
								'size-4 transition-transform duration-300 ease-[cubic-bezier(0.65,0,0.35,1)] motion-reduce:transition-none',
								!collapsed && 'rotate-180',
							)}
						/>
					</span>
				</button>
			</Heading>

			<div
				id={listId}
				inert={collapsed}
				className={cn(
					'grid transition-[grid-template-rows,opacity] duration-[400ms] ease-[cubic-bezier(0.65,0,0.35,1)] motion-reduce:transition-none',
					collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
				)}
			>
				<div className="min-h-0 overflow-hidden">
					<ol className="border-t border-[color:var(--ah-line-soft)]">
						{items.map((item, i) => (
							<Row
								key={item.lessonId}
								item={item}
								progressKnown={progressKnown}
								isNext={i === nextIndex}
							/>
						))}
					</ol>
				</div>
			</div>
		</div>
	)
}

function Row({
	item,
	progressKnown,
	isNext,
}: {
	item: Item
	progressKnown: boolean
	isNext: boolean
}) {
	const recede = progressKnown && item.completed
	return (
		<li className="border-t border-[color:var(--ah-line-soft)] first:border-t-0">
			{/* Phone: the reason runs full width under thumbnail and title, so
			    it is not squeezed into the column beside a 16:9 still. */}
			<a
				href={item.href}
				className={cn(
					'group/row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-2 px-4 py-3 sm:gap-x-4 sm:gap-y-1 sm:px-5',
					'transition-[background-color,box-shadow] duration-200 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
					// Next up sits on the accent wash with a hairline, a step
					// above the other rows; its hover firms the hairline instead
					// of swapping the wash for the generic hover tint.
					isNext
						? 'bg-[color:var(--ah-accent-wash)] shadow-[inset_0_0_0_1px_var(--ah-line-soft)] hover:shadow-[inset_0_0_0_1px_var(--ah-line-strong)] active:bg-[color:var(--ah-hover)]'
						: 'hover:bg-[color:var(--ah-hover)]/60 active:bg-[color:var(--ah-hover)]',
				)}
			>
				<Thumbnail item={item} recede={recede} />
				<span className="col-start-2 row-start-1 flex flex-col gap-0.5 sm:self-end">
					{isNext ? (
						<span className={cn(TYPE.metaMark, 'text-primary font-medium')}>
							Next up
						</span>
					) : null}
					<span
						className={cn(
							TYPE.cardTitle,
							'text-[15px] decoration-[color:var(--ah-fg-faint)] underline-offset-[3px] transition-colors group-hover/row:underline sm:text-base',
							recede
								? 'group-hover/row:text-foreground text-[color:var(--ah-fg-muted)]'
								: 'text-foreground',
						)}
					>
						{item.title}
					</span>
				</span>
				<span
					className={cn(
						TYPE.metaSm,
						'col-span-3 row-start-2 text-[color:var(--ah-fg-muted)] sm:col-span-1 sm:col-start-2 sm:self-start sm:text-sm sm:leading-[1.45]',
						'[&_code]:bg-foreground/[0.06] [&_code]:text-foreground/85 [&_code]:rounded-[4px] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:whitespace-nowrap',
					)}
				>
					{item.reason}
				</span>
				{progressKnown ? (
					<Mark completed={item.completed} isNext={isNext} />
				) : null}
			</a>
		</li>
	)
}

function Thumbnail({ item, recede }: { item: Item; recede: boolean }) {
	return (
		<span
			className={cn(
				'bg-muted relative col-start-1 row-start-1 aspect-video w-[96px] shrink-0 overflow-hidden rounded-[6px] border border-[color:var(--ah-line-soft)] sm:row-span-2 sm:w-[120px]',
				// Stripes only stand in for a missing still; behind a faded
				// completed still they would show through.
				!item.thumbnailUrl && 'bg-stripes',
			)}
		>
			{item.thumbnailUrl ? (
				<img
					src={item.thumbnailUrl}
					alt=""
					loading="lazy"
					decoding="async"
					width={480}
					height={270}
					className={cn(
						'absolute inset-0 size-full object-cover transition-[scale,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/row:scale-105 motion-reduce:transition-none motion-reduce:group-hover/row:scale-100',
						recede && 'opacity-60 group-hover/row:opacity-100',
					)}
				/>
			) : null}
			{item.durationSeconds ? (
				<span className="absolute right-1 bottom-1 rounded-[3px] bg-black/70 px-1 py-px font-mono text-[10px] leading-[1.4] text-white tabular-nums">
					{formatDuration(item.durationSeconds)}
				</span>
			) : null}
		</span>
	)
}

/** Shape carries the state (filled check vs empty ring); colour only adds to it. */
function Mark({ completed, isNext }: { completed: boolean; isNext: boolean }) {
	return (
		<span className="animate-in fade-in col-start-3 row-start-1 flex shrink-0 items-center duration-300 sm:row-span-2">
			{completed ? (
				<span className="flex size-[22px] items-center justify-center rounded-full bg-[color:var(--ah-mark-yes)] text-[color:var(--card)]">
					<Check aria-hidden className="size-3.5" strokeWidth={3} />
					<span className="sr-only">Completed</span>
				</span>
			) : (
				<span
					className={cn(
						'size-[22px] rounded-full border-[1.5px]',
						isNext
							? 'border-primary'
							: 'border-dashed border-[color:var(--ah-fg-faint)]',
					)}
				>
					<span className="sr-only">Not completed yet</span>
				</span>
			)}
		</span>
	)
}

function Segments({ total, completed }: { total: number; completed: number }) {
	if (total < 2) return null
	return (
		<span aria-hidden className="hidden shrink-0 items-center gap-[3px] sm:flex">
			{Array.from({ length: total }, (_, i) => (
				<span
					key={i}
					className={cn(
						'h-1.5 w-4 rounded-full transition-colors duration-300',
						i < completed
							? 'bg-[color:var(--ah-mark-yes)]'
							: 'bg-foreground/10',
					)}
				/>
			))}
		</span>
	)
}

function formatDuration(seconds: number) {
	const m = Math.floor(seconds / 60)
	const s = Math.round(seconds % 60)
	return `${m}:${s.toString().padStart(2, '0')}`
}
