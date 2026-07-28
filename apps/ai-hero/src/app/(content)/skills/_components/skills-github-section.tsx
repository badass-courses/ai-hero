import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { getRepoStarCount } from '@/lib/github-stars-query'
import { SKILLS_HERO, SKILLS_REPO_URL } from '@/lib/skills-content'
import { Star } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { InstallCommand } from './install-command'

/**
 * GET THE SKILLS (`Skills Page.dc.html` § GET THE SKILLS).
 *
 * The page's closing ask: the same command as the head, restated where a
 * reader who has just finished the catalog is standing, with the repo under
 * it. Two equal columns, because the sentence and the command are peers here
 * (DESIGN rule 4 covers editorial splits; this is a claim and its control).
 *
 * The previous version spent a full section on the star count set at 60px,
 * which is the hero-metric template DESIGN bans. The number now appears once
 * in the head's fact row and once, small, on the repo badge.
 */
export async function SkillsGitHubSection({
	stars: starsProp,
}: {
	/**
	 * GitHub star count, consolidated at the page level (spec §7). When omitted
	 * the component fetches it itself so standalone usage still works.
	 */
	stars?: number | null
} = {}) {
	const stars =
		starsProp !== undefined
			? starsProp
			: await getRepoStarCount(SKILLS_HERO.repoOwner, SKILLS_HERO.repoName)

	return (
		<section
			aria-labelledby="skills-install-heading"
			className="border-border border-b bg-[color:var(--ah-band)]"
		>
			<div className="grid max-w-[1000px] grid-cols-1 gap-8 px-8 pb-[50px] pt-12 sm:px-11 lg:grid-cols-[repeat(2,minmax(0,1fr))] lg:items-center lg:gap-11">
				<div className="min-w-0">
					<p className={cn(TYPE.micro, 'text-[color:var(--ah-fg-label)]')}>
						How to get the skills
					</p>
					<h2
						id="skills-install-heading"
						className={cn(TYPE.heading, 'mb-3 mt-3.5 text-balance')}
					>
						One command, then get to work
					</h2>
					<p
						className={cn(
							TYPE.body,
							'max-w-[46ch] text-pretty text-[color:var(--ah-fg-muted)]',
						)}
					>
						Run it once, then type a slash command in your coding agent.
						Everything is MIT licensed and lives in one repo.
					</p>
				</div>
				<div className="min-w-0">
					<InstallCommand
						command={SKILLS_HERO.installCommand}
						className="mb-3"
					/>
					<Link
						href={SKILLS_REPO_URL}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={
							stars !== null
								? `View ${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName} on GitHub, ${stars.toLocaleString('en-US')} stars`
								: `View ${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName} on GitHub`
						}
						className="border-input bg-background hover:border-foreground/25 focus-visible:ring-ring flex items-center gap-2.5 rounded-[9px] border px-4 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						{stars !== null ? (
							<>
								<Star
									aria-hidden
									className="text-primary size-3.5 shrink-0 fill-current"
								/>
								<span className={cn(TYPE.metaMono, 'font-medium')}>
									{stars.toLocaleString('en-US')}
								</span>
							</>
						) : null}
						<span
							className={cn(
								TYPE.metaMono,
								'min-w-0 truncate text-[color:var(--ah-fg-subtle)]',
							)}
						>
							{SKILLS_HERO.repoOwner}/{SKILLS_HERO.repoName}
						</span>
						<span
							className={cn(
								TYPE.metaSm,
								'ml-auto whitespace-nowrap text-[color:var(--ah-fg-subtle)]',
							)}
						>
							View on GitHub →
						</span>
					</Link>
				</div>
			</div>
		</section>
	)
}
