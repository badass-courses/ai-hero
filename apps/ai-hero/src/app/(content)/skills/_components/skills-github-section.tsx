import * as React from 'react'
import Link from 'next/link'
import { getRepoStarCount } from '@/lib/github-stars-query'
import { ArrowUpRight, Github, Star } from 'lucide-react'

const REPO_OWNER = 'mattpocock'
const REPO_NAME = 'skills'
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`

export async function SkillsGitHubSection() {
	const stars = await getRepoStarCount(REPO_OWNER, REPO_NAME)

	return (
		<section aria-labelledby="skills-github-heading">
			<div className="flex flex-col items-center gap-6 px-8 py-20 sm:px-16 md:py-24">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					Open source
				</span>
				{stars !== null && (
					<div
						aria-label={`${stars.toLocaleString('en-US')} stars on GitHub`}
						className="flex items-center gap-3"
					>
						<Star
							aria-hidden
							className="text-primary h-7 w-7 fill-current sm:h-8 sm:w-8"
						/>
						<span className="font-mono text-5xl font-semibold tracking-tight sm:text-6xl">
							{stars.toLocaleString('en-US')}
						</span>
					</div>
				)}
				<h2
					id="skills-github-heading"
					className="text-balance text-center font-sans text-2xl font-medium leading-tight tracking-tight sm:text-3xl"
				>
					<Link
						href={REPO_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="font-mono underline-offset-4 hover:underline"
					>
						{REPO_OWNER}/{REPO_NAME}
					</Link>
				</h2>
				<p className="text-muted-foreground max-w-xl text-balance text-center text-base sm:text-lg">
					Skills for Real Engineers. Straight from my .claude directory.
				</p>
				<Link
					href={REPO_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="border-border hover:bg-muted group inline-flex items-center gap-2 border px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wider transition-colors"
				>
					<Github aria-hidden className="size-4" />
					<span>View on GitHub</span>
					<ArrowUpRight
						aria-hidden
						className="size-4 transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
					/>
				</Link>
			</div>
		</section>
	)
}
