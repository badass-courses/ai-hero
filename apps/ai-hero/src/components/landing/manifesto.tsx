import * as React from 'react'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The page's argument, set as a claim against its reasoning.
 *
 * Two columns, no rule between them (`Home Page.dc.html` § MANIFESTO). The
 * body column is offset down by the gutter instead: a hairline here read as a
 * table of two equal things, and this is one statement with its case
 * underneath, not a comparison.
 *
 * The closing paragraph is set in full ink at medium weight. It is the only
 * sentence in the section a reader has to leave with, and at body opacity it
 * disappeared into the two paragraphs of setup above it.
 */
export function Manifesto({
	eyebrow = 'The argument',
	headline,
	children,
}: {
	eyebrow?: string
	headline: string
	children: React.ReactNode
}) {
	return (
		<section className="border-border grid grid-cols-1 gap-8 border-b px-8 py-14 sm:px-11 sm:pb-[72px] sm:pt-[76px] md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:gap-16">
			<div className="flex flex-col gap-5">
				{eyebrow ? (
					<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
						{eyebrow}
					</p>
				) : null}
				<h2 className={cn(TYPE.sectionClaim, 'text-balance font-sans')}>
					{headline}
				</h2>
			</div>
			<div
				className={cn(
					TYPE.body,
					'flex max-w-[62ch] flex-col gap-5 text-pretty text-[color:var(--ah-fg-body)] md:pt-11',
					// The MDX pipeline gives every `p` a bottom margin of its own,
					// which doubled with the flex gap. The gap is the spacing here.
					'[&>p]:m-0!',
					'[&>p:last-child]:text-foreground [&>p:last-child]:font-medium',
				)}
			>
				{children}
			</div>
		</section>
	)
}
