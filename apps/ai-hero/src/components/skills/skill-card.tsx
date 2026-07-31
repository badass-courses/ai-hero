import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { getCachedGoalSectionItems } from '@/lib/goal-sections-query'
import { ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * A skill, rendered as the thing it actually is: a slash command you type at
 * an agent.
 *
 * The previous treatment was a full-width bordered strip containing the
 * sentence "Try my /grill-me skill →", which reads as a banner ad and buries
 * the one token a reader recognises inside prose. Here the command IS the
 * card's headline, set in mono at heading scale with the leading slash in
 * `--primary`, matching the `$` in `InstallCommand` — so skills look the same
 * wherever they appear.
 *
 * The tagline is the skill post's own `description`, resolved server-side, so
 * cards never drift from the CMS copy. When the slug does not resolve to a
 * published + public post the card renders nothing rather than a broken link.
 */
export async function SkillCard({
	slug,
	label,
	className,
}: {
	/** Flat root slug of the skill post, e.g. `skills-grill-me`. */
	slug: string
	/** Optional lead-in above the command, e.g. "Do this with". */
	label?: string
	className?: string
}) {
	const resolved = await getCachedGoalSectionItems([slug])
	const skill = resolved.get(slug)
	if (!skill) return null

	return (
		<Link
			href={`/${slug}`}
			className={cn(
				// The spec's list card: `--ah-r-md` (11px) on the card surface at the
				// card border weight, hover moving the border only. It was a square
				// `bg-muted/40` strip with a divider-weight border, which read as a
				// band rather than as something you click.
				'border-input bg-card hover:border-foreground/30 focus-visible:ring-ring group flex w-full items-center gap-5 rounded-md border px-5 py-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
				className,
			)}
		>
			<span className="flex min-w-0 flex-col gap-1">
				{label ? (
					<span className={TYPE.groupLabel}>{label}</span>
				) : null}
				<span className={cn(TYPE.subhead, 'truncate font-mono')}>
					<span aria-hidden className="text-primary">
						/
					</span>
					{commandName(slug)}
				</span>
				{skill.description ? (
					<span
						className={cn(
							TYPE.metaProse,
							'line-clamp-2 text-[color:var(--ah-fg-muted)]',
						)}
					>
						{skill.description}
					</span>
				) : null}
			</span>
			{/* The spec's 34px circular row arrow, the same affordance the landing
			    rows use, rather than a bare glyph. */}
			<span
				aria-hidden
				className="border-input text-[color:var(--ah-fg-muted)] group-hover:text-foreground group-hover:border-foreground/30 ml-auto flex size-[34px] shrink-0 items-center justify-center rounded-full border transition-colors"
			>
				<ArrowRight className="ease-out-quart size-4 transition-transform duration-300 group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none" />
			</span>
		</Link>
	)
}

/**
 * `skills-grill-me` → `grill-me`. Every skill post is titled "The /… Skill",
 * so the bare command is the only part worth showing large.
 */
function commandName(slug: string): string {
	return slug.replace(/^skills-/, '')
}
