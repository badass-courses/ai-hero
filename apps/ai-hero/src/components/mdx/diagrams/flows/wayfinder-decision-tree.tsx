'use client'

import * as React from 'react'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/ui/utils/cn'

import { Centred } from '../centred'
import { FLOW_ROLES } from '../roles'

type Kind = 'start' | 'question' | 'outcome'

type Choice = {
	id: string
	kind: Kind
	title: string
	text: string
	/** Where a "Yes" goes. A question's "No" goes on down the spine. */
	yes?: Choice
}

/**
 * Matt's "Grill vs Wayfinder vs Ship First" decision tree, from the Wayfinder
 * workshop. One spine runs down the left; each question branches right on
 * "Yes" and carries on down on "No". Every word is his.
 */
const CHOICES: readonly Choice[] = [
	{
		id: 'new-session',
		kind: 'start',
		title: 'A New Session',
		text: 'You want to create a new piece of work and you don’t know what to choose.',
	},
	{
		id: 'diff-tiny',
		kind: 'question',
		title: 'Is the diff tiny?',
		text: 'Can you review the agent’s diff quickly? Does it cost almost no time to try again?',
		yes: {
			id: 'one-shot',
			kind: 'outcome',
			title: 'One Shot',
			text: 'No need to align before you begin. Align AFTER you see the diff.',
		},
	},
	{
		id: 'grill-with-docs',
		kind: 'outcome',
		title: '/grill-with-docs',
		text: 'Align before you build, and firm up your domain language.',
	},
	{
		id: 'bigger',
		kind: 'question',
		title: 'Is it bigger than you thought?',
		text: 'Is the grilling session going into the dumb zone? Is there more fog than expected?',
		yes: {
			id: 'wayfinder',
			kind: 'outcome',
			title: '/wayfinder',
			text: 'Turn your initial grilling session into a Wayfinder map, and go from there.',
		},
	},
	{
		id: 'keep-going',
		kind: 'outcome',
		title: 'Keep going',
		text: 'Grill, grill, grill!',
	},
]

/** Matt's markers: a blue circle to start, an orange diamond for a question,
    a yellow square for what to do. The hues are the flow cast's, so the
    drawings share one palette. */
const MARKS: Record<Kind, { hue: string; shape: string }> = {
	start: { hue: FLOW_ROLES.orchestrator.hue, shape: 'rounded-full' },
	question: {
		hue: FLOW_ROLES.git.hue,
		shape: 'size-4 rotate-45 rounded-[4px]',
	},
	outcome: { hue: FLOW_ROLES.runner.hue, shape: 'rounded-[6px]' },
}

/** The house ink (the Software Factory map's), opaque so a line running
    under its arrowhead shows no brighter patch. */
const INK = 'text-[color-mix(in_oklab,var(--foreground)_58%,var(--background))]'

/**
 * The Wayfinder decision tree. HTML lays it out and every connector is an
 * SVG line sized by the box it sits in (percentages), so nothing is measured
 * and the arrows hold at any width. On a phone the "Yes" arrows shorten and
 * the outcomes wrap; the spine and every branch stay where they are.
 */
export function WayfinderDecisionTree() {
	const markerId = React.useId()

	return (
		<figure className="not-prose @container my-8">
			<Centred>
				<svg aria-hidden className="absolute size-0">
					<defs>
						<marker
							id={markerId}
							viewBox="0 0 8 9"
							refX="8"
							refY="4.5"
							markerWidth="8"
							markerHeight="9"
							markerUnits="userSpaceOnUse"
							orient="auto"
						>
							<path
								d="M8 4.5 L0 0 L0 9 Z"
								fill="color-mix(in oklab, var(--foreground) 58%, var(--background))"
							/>
						</marker>
					</defs>
				</svg>
				{/* Matt's tree is narrow beside his page; at full width the "Yes"
			    arrows would outrun the steps they join. */}
				<ol className="@2xl:max-w-[40rem]">
					{CHOICES.map((choice, index) => {
						const next = CHOICES[index + 1]
						return (
							<li key={choice.id} className={cn('relative', next && 'pb-10')}>
								{next ? (
									<Connector
										edge={`${choice.id}-${next.id}`}
										marker={markerId}
										className="top-8 bottom-1"
									/>
								) : null}
								<Step choice={choice} />
								{choice.yes ? (
									<>
										<Branch
											to={choice.yes}
											from={choice.id}
											marker={markerId}
										/>
										<span
											className={cn(
												TYPE.meta,
												'bg-background relative mt-4 block w-6 py-1 text-center font-bold',
											)}
										>
											No
										</span>
									</>
								) : null}
							</li>
						)
					})}
				</ol>
				<ul className="sr-only">
					{CHOICES.flatMap((choice, index) => {
						const next = CHOICES[index + 1]
						return [
							choice.yes ? (
								<li key={`${choice.id}-yes`}>
									{choice.title} Yes: {choice.yes.title}
								</li>
							) : null,
							next ? (
								<li key={`${choice.id}-next`}>
									{choice.title} {choice.yes ? 'No: ' : 'leads to '}
									{next.title}
								</li>
							) : null,
						]
					})}
				</ul>
			</Centred>
		</figure>
	)
}

/** A marker beside its title and the line under it. */
function Step({ choice, className }: { choice: Choice; className?: string }) {
	const mark = MARKS[choice.kind]
	return (
		<div data-node={choice.id} className={cn('relative flex gap-3', className)}>
			<span
				aria-hidden
				className="flex size-6 shrink-0 items-center justify-center"
			>
				<span
					className={cn('block size-5 border-2', mark.shape)}
					style={{
						borderColor: mark.hue,
						backgroundColor: `color-mix(in oklab, ${mark.hue} 22%, var(--background))`,
					}}
				/>
			</span>
			<span className="min-w-0 pt-0.5">
				<span className={cn(TYPE.cardTitle, 'block')}>{choice.title}</span>
				<span
					className={cn(
						TYPE.metaSm,
						'text-muted-foreground mt-1 block max-w-xs text-pretty',
					)}
				>
					{choice.text}
				</span>
			</span>
		</div>
	)
}

/** A question's "Yes": a line from the spine to the outcome, labelled where
    it leaves. The outcome starts a little past halfway across, as in Matt's
    drawing; on a phone it takes more of the width so its text can wrap. */
function Branch({
	from,
	to,
	marker,
}: {
	from: string
	to: Choice
	marker: string
}) {
	return (
		<div className="mt-6 flex items-start">
			<span className="w-3 shrink-0" />
			<span className="relative flex h-6 min-w-0 flex-1 items-center">
				<svg
					aria-hidden
					className={cn('absolute inset-0 size-full overflow-visible', INK)}
				>
					<line
						data-edge={`${from}-${to.id}`}
						x1="0"
						y1="50%"
						x2="100%"
						y2="50%"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						markerEnd={`url(#${marker})`}
					/>
				</svg>
				<span
					className={cn(
						TYPE.meta,
						'bg-background relative ml-3 px-1.5 font-bold',
					)}
				>
					Yes
				</span>
			</span>
			<Step choice={to} className="ml-2 w-[62%] shrink-0 @2xl:w-[48%]" />
		</div>
	)
}

/** The spine's arrow from one step down to the next, along the left. */
function Connector({
	edge,
	marker,
	className,
}: {
	edge: string
	marker: string
	className: string
}) {
	return (
		// An SVG ignores `top` and `bottom` for its height, so a box takes them
		// and the SVG fills it.
		<span aria-hidden className={cn('absolute left-0 w-6', className)}>
			<svg className={cn('size-full overflow-visible', INK)}>
				<line
					data-edge={edge}
					x1="50%"
					y1="0"
					x2="50%"
					y2="100%"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					markerEnd={`url(#${marker})`}
				/>
			</svg>
		</span>
	)
}
