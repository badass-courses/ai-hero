import * as React from 'react'
import Link from 'next/link'
import { getCachedGoalSectionItems } from '@/lib/goal-sections-query'
import { ArrowRight } from 'lucide-react'

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
			className={[
				'border-border bg-muted/40 hover:border-foreground/30 hover:bg-muted focus-visible:ring-ring group flex w-full items-center gap-5 border px-5 py-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
				className,
			]
				.filter(Boolean)
				.join(' ')}
		>
			<span className="flex min-w-0 flex-col gap-1">
				{label ? (
					<span className="text-muted-foreground font-mono text-[11px] font-medium uppercase tracking-wider">
						{label}
					</span>
				) : null}
				<span className="truncate font-mono text-lg font-semibold tracking-tight sm:text-xl">
					<span aria-hidden className="text-primary">
						/
					</span>
					{commandName(slug)}
				</span>
				{skill.description ? (
					<span className="text-muted-foreground line-clamp-2 text-sm leading-relaxed">
						{skill.description}
					</span>
				) : null}
			</span>
			<ArrowRight
				aria-hidden
				className="text-muted-foreground group-hover:text-foreground ease-out-quart ml-auto size-5 shrink-0 transition-all duration-300 group-hover:translate-x-1 motion-reduce:transform-none motion-reduce:transition-none"
			/>
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
