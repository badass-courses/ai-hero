import * as React from 'react'
import Link from 'next/link'
import type { DictionarySection } from '@/lib/ai-coding-dictionary'
import { getRepoStarCount } from '@/lib/github-stars-query'
import { ArrowUpRight, Github, Star } from 'lucide-react'

import { sectionId } from './section-id'

const REPO_OWNER = 'mattpocock'
const REPO_NAME = 'dictionary-of-ai-coding'
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`

export async function DictionaryHero({
	sections,
	entryCount,
}: {
	sections: DictionarySection[]
	entryCount: number
}) {
	const stars = await getRepoStarCount(REPO_OWNER, REPO_NAME)

	return (
		<header
			id="dictionary-hero"
			className="border-border relative grid w-full grid-cols-1 items-stretch border-b md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
		>
			<div className="flex flex-col justify-center gap-4 px-8 py-16 sm:px-16 sm:py-20">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					AI Hero · Dictionary
				</p>
				<h1 className="text-balance font-sans text-4xl font-normal leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
					The vocabulary of AI coding,
					<br className="hidden sm:block" />{' '}
					<span className="text-primary">in plain English</span>.
				</h1>
				<p className="text-muted-foreground mb-2 max-w-2xl text-balance text-xl font-light leading-tight tracking-tight sm:text-2xl">
					Skimmable definitions for the terms that make agentic coding click.
					Search {entryCount} entries below, or jump into a section.
				</p>
				<GitHubBadge stars={stars} />
			</div>
			<div className="border-border bg-stripes relative hidden w-full flex-col items-center justify-center overflow-hidden font-mono text-base md:flex md:border-l">
				<ul className="flex max-h-full flex-col gap-2 overflow-hidden">
					{sections.slice(0, 7).map((section) => (
						<li key={section.title}>
							<Link
								href={`#${sectionId(section.title)}`}
								className="hover:text-primary group inline-flex items-center transition-colors"
							>
								<span className="text-primary mr-0.5 opacity-75 transition-opacity group-hover:opacity-100 dark:opacity-100">
									#
								</span>
								<span className="font-medium underline decoration-transparent decoration-1 underline-offset-4 transition group-hover:decoration-current">
									{section.title.toLowerCase().replace(/\s+/g, '-')}
								</span>
							</Link>
						</li>
					))}
				</ul>
			</div>
		</header>
	)
}

function GitHubBadge({ stars }: { stars: number | null }) {
	return (
		<Link
			href={REPO_URL}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={
				stars !== null
					? `View ${REPO_OWNER}/${REPO_NAME} on GitHub, ${stars.toLocaleString('en-US')} stars`
					: `View ${REPO_OWNER}/${REPO_NAME} on GitHub`
			}
			className="text-muted-foreground hover:text-foreground group inline-flex items-center gap-2 self-start font-mono text-xs transition-colors"
		>
			{stars !== null && (
				<>
					<span className="text-foreground inline-flex items-center gap-1">
						<Star aria-hidden className="text-primary size-3.5 fill-current" />
						{stars.toLocaleString('en-US')}
					</span>
					<span aria-hidden className="opacity-50">
						·
					</span>
				</>
			)}
			<Github aria-hidden className="size-4" />
			<span>
				{REPO_OWNER}/{REPO_NAME}
			</span>
			<ArrowUpRight
				aria-hidden
				className="size-3.5 transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
			/>
		</Link>
	)
}
