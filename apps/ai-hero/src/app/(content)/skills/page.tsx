import { Suspense } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { TYPE } from '@/components/landing/type'
import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import { getRepoStarCount } from '@/lib/github-stars-query'
import { getCachedFilteredList } from '@/lib/lists-query'
import {
	getCachedSkillChangelogEntries,
	type SkillChangelogEntry,
} from '@/lib/skill-changelog-query'
import {
	SKILLS_HERO,
	SKILLS_LIST_ID,
	SKILLS_PAGE_SIZE,
	SKILLS_REPO_URL,
} from '@/lib/skills-content'
import { RssIcon } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import type { ChangelogItem } from './_components/changelog-list'
import {
	ChangelogPage,
	PaginatedChangelog,
} from './_components/paginated-changelog'
import { countSkills, toSkillGroups } from './_components/skill-groups'
import { SkillSet } from './_components/skill-set'
import { SkillsGitHubSection } from './_components/skills-github-section'
import { SkillsHero } from './_components/skills-hero'
import { SkillsSalesCopy } from './_components/skills-sales-copy'

export const revalidate = 3600
export const dynamic = 'force-static'

export const metadata: Metadata = {
	title: SKILLS_HERO.title,
	description: SKILLS_HERO.tagline,
	alternates: {
		canonical: '/skills',
		types: {
			'application/rss+xml': [
				{ url: '/skills/rss.xml', title: 'AI Hero Skills' },
			],
		},
	},
	openGraph: {
		images: [
			{
				url: 'https://res.cloudinary.com/total-typescript/image/upload/v1777381841/skills-og_2x.jpg',
			},
		],
	},
}

/**
 * /skills — the skill system's own page (`Skills Page.dc.html`).
 *
 * The order is the argument: what you get and how to install it (HEAD), the
 * catalog (THE SKILL SET), what a skill even is (WHAT A SKILL IS), what changed
 * (CHANGELOG), and the ask restated at the bottom (GET THE SKILLS).
 *
 * The catalog leads the definition, not the other way round: someone on this
 * page is deciding whether the set is worth installing, and the list is what
 * answers that. The definition then lands as the answer to a question the list
 * has already raised rather than as a preamble to it.
 *
 * Every count, group, order and description on the page is CMS or GitHub data.
 * The list (`SKILLS_LIST_ID`) owns the grouping AND the order of the groups —
 * to lead with "The Main Flow" rather than "Getting Started", move the section
 * in the list, not in this file.
 */
export default async function SkillsPage() {
	const [entries, skillsList, stars] = await Promise.all([
		getCachedSkillChangelogEntries({ limit: 1000 }),
		getCachedFilteredList(SKILLS_LIST_ID),
		getRepoStarCount(SKILLS_HERO.repoOwner, SKILLS_HERO.repoName),
	])

	const skillGroups = toSkillGroups(skillsList?.resources)
	const skillCount = countSkills(skillGroups)
	const changelogItems = entries.map(toChangelogItem)
	return (
		<LayoutClient withContainer withFooter={false}>
			<HubLayout>
				<main className="bg-background text-foreground">
					<SkillsHero stars={stars} skillCount={skillCount} />

					{/* The catalog first, the definition after it. A reader arriving
					    here has installed something or is deciding whether to — they
					    want to see what the set actually contains before they want an
					    essay on what a skill is. The definition reads better as the
					    answer to a question the list has already raised. */}
					<SkillSet groups={skillGroups} />

					<SkillsSalesCopy />

					<section aria-labelledby="changelog-heading" className="border-b">
						<div className="px-[18px] pb-[50px] pt-12 sm:px-11">
							<div className="mb-[26px] flex flex-col gap-4 md:flex-row md:items-end">
								<div>
									<p className={TYPE.groupLabel}>Changelog</p>
									<h2
										id="changelog-heading"
										className={cn(TYPE.heading, 'mt-3.5 text-balance')}
									>
										What changed recently
									</h2>
								</div>
								<div className="flex items-center gap-5 md:ml-auto md:shrink-0">
									<Link
										href="/skills/rss.xml"
										className={cn(
											TYPE.meta,
											'hover:text-foreground inline-flex items-center gap-1.5 text-[color:var(--ah-fg-subtle)] transition-colors',
										)}
									>
										<RssIcon className="size-3.5" aria-hidden />
										RSS
									</Link>
									<Link
										href={`${SKILLS_REPO_URL}/releases`}
										target="_blank"
										rel="noopener noreferrer"
										className={cn(
											TYPE.meta,
											'hover:text-foreground text-[color:var(--ah-fg-subtle)] transition-colors',
										)}
									>
										Full history on GitHub →
									</Link>
								</div>
							</div>
							<Suspense
								fallback={
									<ChangelogPage
										items={changelogItems}
										currentPage={1}
										pageSize={SKILLS_PAGE_SIZE}
									/>
								}
							>
								<PaginatedChangelog
									items={changelogItems}
									pageSize={SKILLS_PAGE_SIZE}
								/>
							</Suspense>
						</div>
					</section>

					<SkillsGitHubSection stars={stars} skillCount={skillCount} />

					{/* No `eyebrow` override. The component's default is already
					    "Trusted by engineers from", which is what the homepage proof
					    block and the subscribe page both show. This route had been
					    shortened to "Engineers from", which names the group without
					    making the claim. */}
					<CompanyLogoGrid
						variant="row"
						className="border-border border-b px-[18px] py-[22px] sm:px-11"
					/>
				</main>
			</HubLayout>
		</LayoutClient>
	)
}

/**
 * Entries are authored as "v1.1: /wayfinder, /to-spec …", so the release
 * number is already in the title. Splitting it out is what lets the changelog
 * set version and date in their own column without a new CMS field; a title
 * without the prefix simply renders without a version.
 */
const VERSION_PREFIX = /^(v\d+(?:\.\d+)*)\s*:\s*(.+)$/

function toChangelogItem(entry: SkillChangelogEntry): ChangelogItem {
	const rawTitle = String(entry.fields?.title ?? 'Untitled skill update')
	const match = rawTitle.match(VERSION_PREFIX)
	const description = entry.fields?.description || entry.fields?.summary
	const slug = String(entry.fields?.slug ?? entry.id)
	const publishedAt = entry.createdAt
		? new Intl.DateTimeFormat('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric',
			}).format(new Date(entry.createdAt))
		: null

	return {
		id: entry.id,
		href: `/skills/${slug}`,
		title: match?.[2] ?? rawTitle,
		version: match?.[1] ?? null,
		description: description ? String(description) : undefined,
		publishedAt,
	}
}
