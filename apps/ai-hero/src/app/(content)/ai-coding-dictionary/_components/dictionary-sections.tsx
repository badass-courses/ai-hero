import * as React from 'react'
import type { DictionarySection } from '@/lib/ai-coding-dictionary'

import { DictionaryTile } from './dictionary-tile'
import { sectionId } from './section-id'

export function DictionarySections({
	sections,
}: {
	sections: DictionarySection[]
}) {
	return (
		<div>
			{sections.map((section) => (
				<section
					key={section.title}
					id={sectionId(section.title)}
					aria-labelledby={`${sectionId(section.title)}-heading`}
					className="border-border scroll-mt-(--nav-height) border-b last:border-b-0"
				>
					<header className="border-border flex items-end justify-between gap-4 border-b px-6 py-5 sm:px-8">
						<h2
							id={`${sectionId(section.title)}-heading`}
							className="font-sans text-xl font-semibold tracking-tight sm:text-2xl"
						>
							{section.title}
						</h2>
						<span className="text-muted-foreground font-mono text-[11px] font-medium uppercase tracking-wider">
							{section.entries.length}{' '}
							{section.entries.length === 1 ? 'term' : 'terms'}
						</span>
					</header>
					<div className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2">
						{section.entries.map((entry) => (
							<DictionaryTile
								key={entry.slug}
								title={entry.title}
								description={entry.description}
								href={`/ai-coding-dictionary/${entry.slug}`}
							/>
						))}
						{section.entries.length % 2 === 1 ? (
							<div aria-hidden className="bg-background hidden sm:block" />
						) : null}
					</div>
				</section>
			))}
		</div>
	)
}
