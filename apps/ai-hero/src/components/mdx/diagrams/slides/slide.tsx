import type * as React from 'react'
import { TYPE } from '@/components/landing/type'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { FLOW_ROLES } from '../roles'

/**
 * A term and the line under it, the unit most of Matt's text slides are made
 * of. `code` sets the term in mono, because it is a command or a filename.
 */
export type SlideItem = {
	term: string
	text?: string
	icon?: LucideIcon
	code?: boolean
}

/**
 * How loud the terms are. Matt sizes them per slide: a lone title the
 * biggest, a stack of concepts a step down, and the stacks with an icon
 * beside each term smaller again.
 */
export type SlideScale = 'title' | 'large' | 'small'

export type StackSlide = {
	scale: SlideScale
	items: readonly SlideItem[]
}

const TERM: Record<SlideScale, string> = {
	title: TYPE.sectionQuiet,
	large: TYPE.heading,
	small: TYPE.panelTitle,
}

/** The line under a term wraps where Matt's does: a title's runs wider than
    a stacked item's. */
const MEASURE: Record<SlideScale, string> = {
	title: 'max-w-[34ch]',
	large: 'max-w-[31ch]',
	small: 'max-w-[27ch]',
}

/** Mono for commands and filenames, without the sans headings' tight
    tracking, which crowds a monospace face. */
const CODE = 'font-mono tracking-[-0.02em]'

/** Matt's grey for the line under a term, as in the Software Factory map. */
const MUTED = 'text-[color:var(--ah-fg-muted)]'

/** A stable hook for each item (`data-node`), from its term. */
const nodeId = (term: string) =>
	term
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')

/**
 * The panel a slide sits in. Unframed, a title slide reads as a second
 * heading under the lesson's own; the hairline panel marks it as a figure,
 * the way a diagram is one, with the slide centred inside.
 */
function Frame({ children, ...props }: React.ComponentProps<'figure'>) {
	return (
		<figure
			{...props}
			className="not-prose border-border @container my-8 rounded-lg border px-5 py-10 @2xl:px-12 @2xl:py-14"
		>
			{children}
		</figure>
	)
}

/**
 * A stack of terms, each with its description in smaller muted type under
 * it. Matt walks through these in his videos by lighting some terms and
 * dimming the rest, or by revealing them one at a time, so a frame says
 * which.
 */
export function Stack({
	slide,
	lit,
	shown = slide.items.length,
}: {
	slide: StackSlide
	/** The terms lit in this frame. The others are dimmed. */
	lit?: readonly string[]
	/** How many items had appeared by this frame. */
	shown?: number
}) {
	const withIcons = slide.items.some((item) => item.icon)
	return (
		<Frame>
			<dl
				className={cn(
					'mx-auto grid w-fit max-w-full gap-y-10 @2xl:gap-y-14',
					slide.scale === 'title' && 'text-center',
					withIcons
						? 'grid-cols-[auto_1fr] gap-x-3 @2xl:gap-x-4'
						: 'grid-cols-1',
				)}
			>
				{slide.items.slice(0, shown).map((item) => {
					const Icon = item.icon
					return (
						<div
							key={item.term}
							data-node={nodeId(item.term)}
							className="col-span-full grid grid-cols-subgrid transition-opacity data-dim:opacity-30"
							data-dim={(lit && !lit.includes(item.term)) || undefined}
						>
							{Icon ? (
								// Set in the term's type so the icon scales with it.
								<span
									aria-hidden
									className={cn(TERM[slide.scale], 'text-foreground flex')}
								>
									<Icon
										strokeWidth={2}
										className="size-[1em] translate-y-[0.1em]"
									/>
								</span>
							) : null}
							<dt
								className={cn(
									TERM[slide.scale],
									'text-foreground',
									withIcons && 'col-start-2',
									item.code && CODE,
								)}
							>
								{item.term}
							</dt>
							{item.text ? (
								<dd
									className={cn(
										TYPE.lead,
										MUTED,
										MEASURE[slide.scale],
										'mt-2 font-medium text-pretty',
										withIcons && 'col-start-2',
									)}
								>
									{item.text}
								</dd>
							) : null}
						</div>
					)
				})}
			</dl>
		</Frame>
	)
}

/**
 * The colours Matt gives the left word of a pair: grey for the side being
 * explained, his yellow and blue for the two kinds of question.
 */
type PairTone = 'muted' | 'amber' | 'blue'

export type PairSlide = {
	rows: readonly { left: string; right: string; tone: PairTone }[]
	code?: { left?: boolean; right?: boolean }
}

const ROLE_TEXT =
	'text-[color:color-mix(in_oklab,var(--role)_72%,var(--foreground))]'

const TONE: Record<PairTone, string> = {
	muted: MUTED,
	// Matt's yellow and blue (`--role`, set inline), leaned toward the text
	// colour so they read in both themes.
	amber: ROLE_TEXT,
	blue: ROLE_TEXT,
}

const TONE_HUE: Partial<Record<PairTone, string>> = {
	amber: FLOW_ROLES.runner.hue,
	blue: FLOW_ROLES.orchestrator.hue,
}

/**
 * Two columns that pair a word on the left with the one it maps to on the
 * right, the left column set flush right against the right one so each pair
 * reads as a phrase. On a phone each pair keeps to its own line and wraps.
 */
export function Pairs({ slide }: { slide: PairSlide }) {
	return (
		<Frame>
			<div className="mx-auto flex w-fit max-w-full flex-col gap-6 @2xl:grid @2xl:grid-cols-[auto_auto] @2xl:gap-x-10 @2xl:gap-y-14">
				{slide.rows.map((row) => (
					<p
						key={`${row.left}-${row.right}`}
						data-node={nodeId(`${row.left} ${row.right}`)}
						className={cn(
							TYPE.panelTitle,
							'flex flex-wrap items-baseline gap-x-4 @2xl:contents',
						)}
					>
						<span
							className={cn(
								TONE[row.tone],
								'@2xl:text-right',
								slide.code?.left && CODE,
							)}
							style={
								TONE_HUE[row.tone]
									? ({ '--role': TONE_HUE[row.tone] } as React.CSSProperties)
									: undefined
							}
						>
							{row.left}
						</span>{' '}
						<span className={cn('text-foreground', slide.code?.right && CODE)}>
							{row.right}
						</span>
					</p>
				))}
			</div>
		</Frame>
	)
}

export type QuoteSlide = {
	paragraphs: readonly string[]
	cite: string
}

/** A quotation Matt puts on screen, with its source under it. The rail is
    the pull-quote rail DESIGN.md allows, standing in for his blue bar. */
export function Quote({ slide }: { slide: QuoteSlide }) {
	return (
		<Frame data-node="quote">
			<blockquote className="border-primary mx-auto max-w-[34em] space-y-5 border-l-2 pl-5">
				{slide.paragraphs.map((paragraph) => (
					<p
						key={paragraph}
						className={cn(TYPE.quoteProse, 'text-foreground text-pretty')}
					>
						{paragraph}
					</p>
				))}
			</blockquote>
			<figcaption
				className={cn(TYPE.meta, MUTED, 'mx-auto mt-6 max-w-[34em] pl-[22px]')}
			>
				{slide.cite}
			</figcaption>
		</Frame>
	)
}
