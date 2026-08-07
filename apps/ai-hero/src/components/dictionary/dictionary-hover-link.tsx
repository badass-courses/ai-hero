'use client'

import * as React from 'react'
import Link from 'next/link'
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from '@/components/ui/hover-card'
import { ArrowRight, BookOpen } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

type DictionaryHoverLinkProps =
	React.AnchorHTMLAttributes<HTMLAnchorElement> & {
		href: string
		dictionaryTitle?: string
		dictionaryDescription?: string
	}

export function DictionaryHoverLink({
	children,
	className,
	dictionaryTitle,
	dictionaryDescription,
	href,
	title: _title,
	...props
}: DictionaryHoverLinkProps) {
	const cardTitle = dictionaryTitle || getTextFromChildren(children)
	const cardDescription = dictionaryDescription || _title

	if (!cardDescription) {
		return (
			<Link href={href} className={className} {...props}>
				{children}
			</Link>
		)
	}

	return (
		<HoverCard openDelay={120} closeDelay={100}>
			<HoverCardTrigger asChild>
				<Link
					href={href}
					className={cn(
						'decoration-primary/40 underline-offset-4 hover:decoration-primary',
						className,
					)}
					{...props}
				>
					{children}
				</Link>
			</HoverCardTrigger>
			<HoverCardContent
				side="top"
				align="start"
				className="not-prose w-80 p-0 shadow-xl"
			>
				<div className="border-border/60 border-b p-4">
					<div className="text-primary mb-2 flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wide">
						<BookOpen className="size-3.5" /> AI Coding Dictionary
					</div>
					<p className="text-foreground text-base font-semibold leading-tight">
						{cardTitle}
					</p>
				</div>
				<div className="p-4">
					<p className="text-muted-foreground text-sm leading-6">
						{cardDescription}
					</p>
					{/* A real link, not a decorated span. It reads as an affordance —
					    accent ink, arrow, "Read definition" — and a reader whose
					    pointer is already inside the card will aim at it rather than
					    travel back to the term that opened it. */}
					<Link
						href={href}
						// The trigger points at the same route and has already
						// prefetched it; a second one per open card buys nothing.
						prefetch={false}
						className="text-primary focus-visible:ring-ring group mt-3 inline-flex items-center gap-1 rounded-[4px] text-sm font-medium underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						Read definition
						<ArrowRight className="ease-out-quart size-3.5 transition-transform duration-300 group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none" />
					</Link>
				</div>
			</HoverCardContent>
		</HoverCard>
	)
}

function getTextFromChildren(children: React.ReactNode): string | undefined {
	if (typeof children === 'string') return children
	if (typeof children === 'number') return String(children)
	if (!Array.isArray(children)) return undefined

	const text = children
		.map((child) =>
			typeof child === 'string' || typeof child === 'number' ? child : '',
		)
		.join('')
		.trim()

	return text.length > 0 ? text : undefined
}
