import * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { Angry, Check, FileText, Flag, Timer } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { FLOW_ROLES } from '../roles'
import { GRAPH_INK } from './ink'

/**
 * The pieces Matt's box-and-arrow drawings are made of, dressed like the
 * cohort page's factory map: card surfaces with a faint opaque border, so a
 * drawing reads as the site's own figure rather than a whiteboard.
 */
const EDGE = 'border-[color:color-mix(in_oklab,var(--foreground)_14%,var(--card))]'

/** A done ticket's tick, in the tracker's green. */
const DONE = FLOW_ROLES.tracker.hue

/** A ticket: its number, what it is, and a tick once it is resolved. */
export function Ticket({
	n,
	label,
	done,
}: {
	n: number
	label: string
	done?: boolean
}) {
	return (
		<div
			className={cn(
				'bg-card relative flex w-36 rounded-[9px] border @2xl:w-40',
				EDGE,
			)}
		>
			<span className={cn(TYPE.cardTitle, EDGE, 'border-r px-2.5 py-2 tabular-nums')}>
				#{n}
			</span>
			<span className={cn(TYPE.cardTitle, 'px-3 py-2')}>{label}</span>
			{done ? (
				<span
					role="img"
					aria-label="done"
					className="bg-card absolute -right-2.5 -top-2.5 grid size-6 place-items-center rounded-full border-2"
					style={{ borderColor: DONE, color: DONE }}
				>
					<Check aria-hidden className="size-3.5" strokeWidth={3} />
				</span>
			) : null}
		</div>
	)
}

/**
 * A module as Matt draws it: a box whose top band is its interface and whose
 * body is its implementation. The band takes the interface's name when he
 * gives one; the body takes either a name or the list of what it hides.
 */
export function ModuleBox({
	head,
	label,
	items,
	className,
}: {
	head?: string
	label?: string
	items?: readonly string[]
	/** The body's height, which is what says deep or shallow. */
	className?: string
}) {
	return (
		<div className={cn('bg-card flex w-full flex-col rounded-md border', EDGE)}>
			<div
				data-graph-part="head"
				className={cn('flex h-8 items-center justify-center border-b px-2', EDGE)}
			>
				{head ? <span className={cn(TYPE.meta, 'font-mono')}>{head}</span> : null}
			</div>
			<div
				className={cn(
					'flex flex-col px-3 py-4 @2xl:px-4',
					items ? 'justify-start' : 'justify-center',
					className,
				)}
			>
				{label ? (
					<span className={cn(TYPE.cardTitle, 'text-center')}>{label}</span>
				) : null}
				{items ? (
					<ul className="flex flex-1 flex-col justify-between gap-2.5">
						{items.map((item) => (
							<li key={item} className={cn(TYPE.meta, 'font-bold')}>
								{item}
							</li>
						))}
					</ul>
				) : null}
			</div>
		</div>
	)
}

const NOTE_TITLE = {
	lg: TYPE.heading,
	md: TYPE.panelTitle,
	sm: TYPE.subhead,
} as const

/** A term and Matt's definition of it, the labels his red arrows leave from. */
export function Note({
	title,
	text,
	size = 'sm',
	align = 'start',
	className,
}: {
	title: string
	text?: string
	size?: keyof typeof NOTE_TITLE
	align?: 'start' | 'end'
	/** Where the definition wraps. */
	className?: string
}) {
	return (
		<div
			className={cn(
				'flex flex-col',
				align === 'end' ? 'items-end text-right' : 'items-start',
				className,
			)}
		>
			<span data-graph-part="title" className={NOTE_TITLE[size]}>
				{title}
			</span>
			{text ? (
				<span
					className={cn(
						size === 'sm' ? TYPE.metaSm : TYPE.metaProse,
						'text-muted-foreground mt-1.5 text-pretty',
					)}
				>
					{text}
				</span>
			) : null}
		</div>
	)
}

/** Where the map leads. */
export function Destination() {
	return (
		<span className={cn(TYPE.cardTitle, 'inline-flex items-center gap-2')}>
			<Flag aria-hidden data-graph-part="flag" className="size-4" strokeWidth={2} />
			Destination
		</span>
	)
}

/** The part of the map nobody can see yet. */
export function Unknown() {
	return <span className={TYPE.heading}>???</span>
}

/** A slash command, written on the line between two tickets. */
export function Command({ children }: { children: string }) {
	return (
		<span className={cn(TYPE.cardTitle, 'whitespace-nowrap font-mono font-medium')}>
			{children}
		</span>
	)
}

const SOURCE_ICONS = { issues: FileText, bugs: Angry, cron: Timer } as const

/** Something that feeds the factory, with its icon and what it is. */
export function Source({
	icon,
	title,
	text,
}: {
	icon: keyof typeof SOURCE_ICONS
	title: string
	text: string
}) {
	const Icon = SOURCE_ICONS[icon]
	return (
		<div className="grid grid-cols-[1.25rem_1fr] items-center gap-x-2.5">
			<Icon aria-hidden className="size-5" strokeWidth={1.75} />
			<span data-graph-part="title" className={cn(TYPE.subhead, 'justify-self-start')}>
				{title}
			</span>
			<span className={cn(TYPE.metaProse, 'text-muted-foreground col-start-2 mt-1 max-w-[21rem]')}>
				{text}
			</span>
		</div>
	)
}

/**
 * A step of the factory: a blue ring and its name, with the elbow and
 * ellipsis Matt draws under it to say the steps carry on from here.
 */
export function Step({ title }: { title: string }) {
	return (
		<div className="flex flex-col">
			<span className="flex items-center gap-3">
				<span
					data-graph-part="dot"
					className="size-4 rounded-full border-[3px]"
					style={{ borderColor: FLOW_ROLES.orchestrator.hue }}
				/>
				<span className={TYPE.panelTitle}>{title}</span>
			</span>
			<span className="text-muted-foreground ml-7 flex items-end gap-3 @2xl:ml-[3.25rem]">
				<svg
					aria-hidden
					viewBox="0 0 80 32"
					preserveAspectRatio="none"
					className="h-8 w-16 @2xl:w-20"
					fill="none"
				>
					<path
						d="M2 1 V30 H78"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						vectorEffect="non-scaling-stroke"
					/>
				</svg>
				<span className={cn(TYPE.subhead, 'leading-none')} aria-label="and more">
					...
				</span>
			</span>
		</div>
	)
}

/** Matt's dashed two-headed arrow beside a module, measuring its depth. It
    stretches to the height of the row it is set in. */
export function DepthRule() {
	return (
		<div
			className="flex h-full w-4 flex-col items-center"
			style={{ color: GRAPH_INK.line }}
		>
			<svg aria-hidden viewBox="0 0 12 8" className="w-3 shrink-0" fill="currentColor">
				<path d="M6 0 L12 8 L0 8 Z" />
			</svg>
			<span className="w-0 flex-1 border-l-2 border-dashed border-current" />
			<svg aria-hidden viewBox="0 0 12 8" className="w-3 shrink-0" fill="currentColor">
				<path d="M6 8 L12 0 L0 0 Z" />
			</svg>
		</div>
	)
}
