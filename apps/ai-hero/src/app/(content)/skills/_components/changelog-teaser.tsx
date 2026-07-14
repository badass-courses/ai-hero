import * as React from 'react'
import Link from 'next/link'

import { type ChangelogItem } from './changelog-list'

/**
 * Compressed "latest update" teaser for the /skills landing (spec §7 step 6).
 * Surfaces only the newest changelog entry (date, title, 1-2 sentence
 * description). The full ChangelogList renders directly below on the same
 * page, so there's no "View all" link (removed 2026-07-14 — redundant when
 * the content sits right under it).
 */
export function ChangelogTeaser({ item }: { item: ChangelogItem }) {
	const isExternal = /^https?:\/\//i.test(item.href)

	return (
		<div className="border-t">
			<Link
				href={item.href}
				prefetch={!isExternal}
				target={isExternal ? '_blank' : undefined}
				rel={isExternal ? 'noopener noreferrer' : undefined}
				className="bg-background hover:bg-muted/40 focus-visible:ring-ring group flex flex-col gap-3 px-8 py-10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-16"
			>
				<span className="flex items-center gap-3 font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					<span>Latest update</span>
					{item.publishedAt ? (
						<>
							<span aria-hidden className="opacity-50">
								·
							</span>
							<span className="opacity-80">{item.publishedAt}</span>
						</>
					) : null}
				</span>
				<h3 className="text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
					{item.title}
				</h3>
				{item.description ? (
					<p className="max-w-[65ch] text-balance text-base leading-relaxed opacity-80">
						{item.description}
					</p>
				) : null}
			</Link>
		</div>
	)
}
