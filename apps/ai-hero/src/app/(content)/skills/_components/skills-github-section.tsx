import * as React from 'react'
import Link from 'next/link'
import { TYPE } from '@/components/landing/type'
import { getRepoStarCount } from '@/lib/github-stars-query'
import { SKILLS_HERO, SKILLS_REPO_URL } from '@/lib/skills-content'
import { Star } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { SkillsInstallOptions } from './skills-install-options'

/**
 * GET THE SKILLS (`Skills Page.dc.html` § GET THE SKILLS).
 *
 * The page's closing ask: the exact same install block as the hero, restated
 * where a reader who has just finished the catalog is standing, with the repo
 * link under it.
 *
 * **Exactly the same, deliberately** — including the layout: the hero's grid,
 * its steps, and its stacked-state rule, so the two instances are one shape.
 * Copy on the left, the install block in a 440px rail on the right.
 *
 * ## Why the columns work here and did not before
 *
 * `SkillsInstallOptions` is container-query driven: the channel descriptions,
 * the second channel and the mobile collapse are all decisions it makes about
 * the nearest container's width. An earlier two-column version of this section
 * put `@container` on the ~470px column itself, so the block resolved to its
 * phone form on a desktop — one command and a "Using Claude Code? Install as a
 * plugin" link, beside a half-empty column of prose.
 *
 * The container is on the full-width padded wrapper instead, which is exactly
 * where the hero puts it. The block queries the section's width and renders its
 * full form, then lays out inside the 440px track — which is arithmetic, not
 * taste: a 40-character command in JetBrains Mono at 12px is 288px of glyphs,
 * plus padding, the copy button and its gap, so 358px is the floor.
 *
 * The left column earns its keep. It carries the heading, the sentence and the
 * repo link, which is this section's version of the hero's stat row: the number
 * is the claim, the link is the receipt.
 *
 * The previous version spent a full section on the star count set at 60px,
 * which is the hero-metric template DESIGN bans. The number appears once in the
 * hero's stat row and once, small, on the repo link at the foot of this one.
 */
export async function SkillsGitHubSection({
	stars: starsProp,
	skillCount,
}: {
	/**
	 * GitHub star count, consolidated at the page level (spec §7). When omitted
	 * the component fetches it itself so standalone usage still works.
	 */
	stars?: number | null
	/** Live count of published skills in the CMS list. */
	skillCount?: number
} = {}) {
	const stars =
		starsProp !== undefined
			? starsProp
			: await getRepoStarCount(SKILLS_HERO.repoOwner, SKILLS_HERO.repoName)

	return (
		<section
			id="install"
			aria-labelledby="skills-install-heading"
			// The page's install anchor. Linked from the compatibility row in the
			// sales copy above, which is where a reader who just learned the set
			// works with their agent wants somewhere to go.
			className="border-border scroll-mt-(--nav-height) border-b bg-[color:var(--ah-band)]"
		>
			{/* `@container` on the padded column, so the block below measures the
			    real width it has. Without a container to query it would resolve every
			    step to its narrowest form no matter how much room it actually has. */}
			<div className="@container px-[18px] pb-[50px] pt-12 sm:px-11">
				{/* `1fr / 1.4fr`, the spec's standard editorial ratio (DESIGN rule 4),
				    with the commands in the wide column. They are the substance of
				    this section; the copy is its label, and a heading, one sentence
				    and a link all stop at their own caps well short of a half-page.

				    NOT the hero's `minmax(34rem,1fr)_440px`. That grid pins the rail
				    and hands the text column every remaining pixel, which is right in
				    the hero — the `h1` and the signup form need the room. Here it
				    bought a lot of empty measure and squeezed the commands into their
				    minimum.

				    `1080px` is the hero's step, kept: below it the two do not fit side
				    by side without arguing, whatever the ratio between them. */}
				<div className="@[1080px]:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] @[1080px]:gap-x-10 grid grid-cols-1 gap-y-10">
					<div className="flex min-w-0 flex-col items-start">
						{/* No eyebrow: the heading under it already says how. */}
						<h2
							id="skills-install-heading"
							className={cn(TYPE.heading, 'mb-3 text-balance')}
						>
							Install the skills and get to work
						</h2>
						{/* Balanced, not pretty. Pretty only saves the last line from going
						    orphan; the heading above is balanced, so a two-line sentence
						    with a long first line read as ragged against it. */}
						<p
							className={cn(
								TYPE.body,
								'mb-7 max-w-[52ch] text-balance text-[color:var(--ah-fg-muted)]',
							)}
						>
							Install the skills you want into the agents you use. Everything is
							MIT licensed and lives in one repo.
						</p>
						<Link
							href={SKILLS_REPO_URL}
							target="_blank"
							rel="noopener noreferrer"
							aria-label={
								stars !== null
									? `View ${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName} on GitHub, ${stars.toLocaleString('en-US')} stars`
									: `View ${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName} on GitHub`
							}
							// `w-full` under the cap: the column is a `flex-col
							// items-start`, so without it the link shrinks to its content
							// and the `ml-auto` on "View on GitHub" has no slack to push
							// into. The cap keeps it from running the column's full width.
							className="border-input bg-background hover:border-foreground/25 focus-visible:ring-ring flex w-full max-w-[520px] items-center gap-2.5 rounded-[9px] border px-4 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
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

					{/* The commands, and the same rule the hero uses: side by side the
					    column gap separates them from the copy, stacked they run into it.
					    The rule only exists where the columns do not. */}
					<SkillsInstallOptions
						className="border-border min-w-0 border-t pt-10 @[1080px]:border-t-0 @[1080px]:pt-0"
						skillCount={skillCount}
					/>
				</div>
			</div>
		</section>
	)
}
