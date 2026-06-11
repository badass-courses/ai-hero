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
					<span className="text-primary mt-3 inline-flex items-center gap-1 text-sm font-medium">
						Read definition <ArrowRight className="size-3.5" />
					</span>
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
