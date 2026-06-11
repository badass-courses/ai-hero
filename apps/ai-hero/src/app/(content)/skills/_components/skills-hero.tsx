import * as React from 'react'
import Link from 'next/link'
import { getRepoStarCount } from '@/lib/github-stars-query'
import {
	FEATURED_SKILL_LINKS,
	SKILLS_HERO,
	SKILLS_REPO_URL,
} from '@/lib/skills-content'
import { ArrowUpRight, Github, Star } from 'lucide-react'

import { InstallCommand } from './install-command'
import * as SkillsNewsletter from './skills-newsletter'
import { type SkillsNewsletterStatus } from './skills-newsletter'

export async function SkillsHero({
	newsletterState,
}: {
	newsletterState: SkillsNewsletterStatus
}) {
	const stars = await getRepoStarCount(
		SKILLS_HERO.repoOwner,
		SKILLS_HERO.repoName,
	)

	return (
		<header
			id="skills-hero"
			className="border-border relative grid w-full grid-cols-1 items-stretch border-b md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
		>
			<div className="flex flex-col justify-center gap-4 px-8 py-16 sm:px-16 sm:py-20">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					AI Hero · Skill System
				</p>
				<h1 className="text-balance font-sans text-4xl font-normal leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
					{SKILLS_HERO.titleLead}{' '}
					<strong className="text-primary font-semibold">
						{SKILLS_HERO.titleEmphasis}
					</strong>
				</h1>
				<p className="text-muted-foreground mb-5 text-balance text-xl font-light leading-tight tracking-tight sm:text-2xl">
					{SKILLS_HERO.tagline}
				</p>
				<div className="flex flex-col">
					<InstallCommand command={SKILLS_HERO.installCommand} />
					<GitHubBadge stars={stars} />
				</div>
			</div>
			<div className="border-border bg-stripes relative flex w-full flex-col items-center justify-center overflow-hidden md:border-l">
				{newsletterState === 'subscribed' ? (
					<ul className="flex flex-col gap-2 font-mono text-base">
						{FEATURED_SKILL_LINKS.map(({ name, slug }) => (
							<li key={slug}>
								<Link
									href={`/${slug}`}
									className="hover:text-primary group inline-flex items-center transition-colors"
								>
									<span className="text-primary mr-0.5 opacity-75 transition-opacity group-hover:opacity-100 dark:opacity-100">
										/
									</span>
									<span className="font-medium underline decoration-transparent decoration-1 underline-offset-4 transition group-hover:decoration-current">
										{name}
									</span>
								</Link>
							</li>
						))}
					</ul>
				) : (
					<SkillsNewsletter.Root
						status={newsletterState}
						location="skills_hero"
					>
						<div className="flex w-full max-w-sm flex-col gap-4 px-8 py-10">
							<SkillsNewsletter.Heading className="w-full text-balance text-center text-base font-medium sm:text-center sm:text-lg">
								Get skill updates in your inbox.
							</SkillsNewsletter.Heading>
							{newsletterState === 'tag-me' ? (
								<SkillsNewsletter.TagMeButton className="bg-primary h-11 px-4 text-sm" />
							) : (
								<SkillsNewsletter.Form
									label="Subscribe"
									className="[&_button]:bg-primary flex flex-col gap-2 [&_button]:h-11 [&_button]:px-4 [&_button]:text-sm [&_input]:h-10 [&_input]:px-3 [&_input]:text-sm"
								/>
							)}
							<SkillsNewsletter.Privacy className="mt-1 text-[10px]" />
						</div>
					</SkillsNewsletter.Root>
				)}
			</div>
		</header>
	)
}

function GitHubBadge({ stars }: { stars: number | null }) {
	return (
		<Link
			href={SKILLS_REPO_URL}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={
				stars !== null
					? `View ${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName} on GitHub, ${stars.toLocaleString('en-US')} stars`
					: `View ${SKILLS_HERO.repoOwner}/${SKILLS_HERO.repoName} on GitHub`
			}
			className="border-border bg-muted/40 text-foreground/90 hover:text-foreground bg-stripes group inline-flex h-12 w-full items-center gap-2 self-start border-x border-b p-3 font-mono text-xs transition-colors"
		>
			{stars !== null && (
				<>
					<span className="text-foreground inline-flex items-center gap-1.5">
						<Star aria-hidden className="text-primary size-3.5 fill-current" />
						{stars.toLocaleString('en-US')}
					</span>
					<span aria-hidden className="opacity-50">
						·
					</span>
				</>
			)}
			<Github aria-hidden className="size-4" />
			<span className="font-medium">
				{SKILLS_HERO.repoOwner}/{SKILLS_HERO.repoName}
			</span>
			<ArrowUpRight
				aria-hidden
				className="ml-auto mr-0.5 size-4 transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
			/>
		</Link>
	)
}
