'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { Highlight } from 'react-instantsearch'

import type { TypesenseResource } from '@/lib/typesense'

const HIGHLIGHT_CLASSES = {
	highlighted: 'bg-primary text-primary-foreground',
} as const

const HIGHLIGHT_CLASSES_MUTED = {
	highlighted: 'bg-primary text-primary-foreground',
	nonHighlighted: 'text-muted-foreground',
} as const

export function DictionaryHit({ hit }: { hit: TypesenseResource }) {
	const href =
		hit.type === 'dictionary'
			? '/ai-coding-dictionary'
			: `/ai-coding-dictionary/${hit.slug}`

	return (
		<Link
			href={href}
			prefetch={false}
			className="bg-background hover:bg-muted/40 group relative flex h-full flex-col gap-3 p-6 transition-colors sm:p-7"
		>
			{hit.type === 'dictionary' ? (
				<span className="font-mono text-[10px] font-medium uppercase tracking-wider opacity-60">
					Index
				</span>
			) : null}
			<div className="flex items-start justify-between gap-3">
				<h3 className="text-lg font-semibold leading-tight tracking-tight sm:text-xl">
					<Highlight
						attribute="title"
						hit={hit as any}
						classNames={HIGHLIGHT_CLASSES}
					/>
				</h3>
				<ArrowUpRight
					aria-hidden
					className="text-muted-foreground size-4 shrink-0 translate-y-0.5 transition-all duration-200 ease-out group-hover:-translate-y-0 group-hover:translate-x-0.5 group-hover:text-foreground"
				/>
			</div>
			{hit.summary ? (
				<p className="line-clamp-3 text-sm leading-relaxed">
					<Highlight
						attribute="summary"
						hit={hit as any}
						classNames={HIGHLIGHT_CLASSES_MUTED}
					/>
				</p>
			) : null}
		</Link>
	)
}
