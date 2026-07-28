import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'

import { cn } from '@coursebuilder/utils/cn'

export type ChangelogItem = {
	id: string
	href: string
	title: string
	description?: string
	publishedAt: string | null
	/** e.g. "v1.1", parsed off the title's `vX.Y:` prefix. */
	version?: string | null
}

/**
 * The changelog, as a release table (`Skills Page.dc.html` § CHANGELOG).
 *
 * Version and date on the left at a fixed 150px, the entry on the right. The
 * previous treatment gave every entry a "Skill update" label, a 54px animated
 * arrow and 8 units of padding, which made four releases fill two screens and
 * read as four articles. A changelog is scanned for "what changed and when",
 * so the row is a line in a table, and the newest release is the only one that
 * takes the accent.
 */
export function ChangelogList({ items }: { items: ChangelogItem[] }) {
	if (items.length === 0) {
		return (
			<p
				className={cn(
					TYPE.micro,
					'border-border border-t py-10 text-[color:var(--ah-fg-label)]',
				)}
			>
				No skill changelog entries have been published yet.
			</p>
		)
	}

	return (
		<ol className="border-border max-w-[960px] border-t">
			{items.map((item, index) => (
				<li key={item.id} className="border-border border-b last:border-b-0">
					<ChangelogRow {...item} isLatest={index === 0} />
				</li>
			))}
		</ol>
	)
}

function ChangelogRow({
	href,
	title,
	description,
	publishedAt,
	version,
	isLatest,
}: ChangelogItem & { isLatest: boolean }) {
	const isExternal = /^https?:\/\//i.test(href)

	return (
		<Link
			href={href}
			prefetch={!isExternal}
			target={isExternal ? '_blank' : undefined}
			rel={isExternal ? 'noopener noreferrer' : undefined}
			className="focus-visible:ring-ring group grid gap-x-6 gap-y-2 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset sm:grid-cols-[150px_minmax(0,1fr)]"
		>
			<div>
				{version ? (
					<span
						className={cn(
							TYPE.command,
							'mb-[5px] block',
							isLatest ? 'text-primary' : 'text-[color:var(--ah-fg-muted)]',
						)}
					>
						{version}
					</span>
				) : null}
				{publishedAt ? (
					<span
						className={cn(
							TYPE.command,
							'block font-normal text-[color:var(--ah-fg-faint)]',
						)}
					>
						{publishedAt}
					</span>
				) : null}
			</div>
			<div>
				<h3
					className={cn(
						TYPE.subhead,
						'mb-1.5 text-balance transition-colors group-hover:text-[color:var(--ah-fg-muted)]',
					)}
				>
					{title}
				</h3>
				{description ? (
					<p
						className={cn(
							TYPE.metaProse,
							'text-pretty text-[color:var(--ah-fg-muted)]',
						)}
					>
						{description}
					</p>
				) : null}
			</div>
		</Link>
	)
}
