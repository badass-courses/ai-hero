import * as React from 'react'
import Link from 'next/link'
import { InstallCommand } from '@/app/(content)/skills/_components/install-command'
import { TYPE } from '@/components/landing/type'
import { type SkillPhase } from '@/lib/skills-shared'

import { cn } from '@coursebuilder/utils/cn'

import { SKILL_SOURCE, invocationName, skillInstallCommand } from './skill-meta'

/**
 * The right cell of a skill page's two-column head — where a lesson would put
 * its video (redesign README §6). A skill has nothing to play; what a reader
 * wants at the top of one is the line that installs it, so the install panel
 * takes the slot rather than leaving the head single-column.
 *
 * Presentational and border-free on purpose: the head grid owns the divider
 * between the two cells, the same way it does for the video variant.
 */
export function SkillInstallPanel({
	slug,
	phase,
	className,
}: {
	/** The skill post's flat root slug, e.g. `skills-grill-me`. */
	slug: string
	/** CMS phase tag metadata, or null when the post carries no phase tag. */
	phase?: SkillPhase | null
	className?: string
}) {
	const command = invocationName(slug)

	return (
		<section
			aria-label="Install this skill"
			className={cn(
				'bg-muted flex h-full flex-col justify-center px-6 py-8 sm:px-10 sm:py-9',
				className,
			)}
		>
			<p className={cn(TYPE.micro, 'mb-3.5 text-[color:var(--ah-fg-label)]')}>
				Install this skill
			</p>
			<InstallCommand
				command={skillInstallCommand(slug)}
				label={`Install command for /${command}`}
			/>
			<p
				className={cn(
					TYPE.metaProse,
					'mt-3 text-[color:var(--ah-fg-muted)]',
				)}
			>
				Then type{' '}
				<code
					className={cn(
						TYPE.command,
						'text-foreground bg-foreground/[0.055] border-border/70 rounded-[4px] border px-1.5 py-0.5',
					)}
				>
					/{command}
				</code>{' '}
				in your coding agent.
			</p>
			<dl className="border-border mt-5 flex flex-wrap gap-x-6 gap-y-4 border-t pt-5">
				{phase ? (
					<div>
						<dt className={cn(TYPE.micro, 'mb-1.5 text-[color:var(--ah-fg-label)]')}>
							Phase
						</dt>
						<dd className={cn(TYPE.meta, 'text-foreground')}>{phase.name}</dd>
					</div>
				) : null}
				<div>
					<dt className={cn(TYPE.micro, 'mb-1.5 text-[color:var(--ah-fg-label)]')}>
						Source
					</dt>
					<dd className={TYPE.meta}>
						<Link
							href={SKILL_SOURCE.href}
							target="_blank"
							rel="noreferrer"
							className="text-primary focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2"
						>
							{SKILL_SOURCE.label}
						</Link>
					</dd>
				</div>
			</dl>
		</section>
	)
}
