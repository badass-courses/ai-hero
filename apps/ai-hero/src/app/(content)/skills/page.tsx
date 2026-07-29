import type { Metadata } from 'next'
import Link from 'next/link'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { TYPE } from '@/components/landing/type'
import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import { getRepoStarCount } from '@/lib/github-stars-query'
import { getListWithSections } from '@/lib/lists-query'
import {
	getSkillChangelogCount,
	getSkillChangelogEntries,
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

import { ChangelogList, type ChangelogItem } from './_components/changelog-list'
import { ChangelogPagination } from './_components/changelog-pagination'
import { SkillSet, type SkillSetGroup } from './_components/skill-set'
import { SkillsGitHubSection } from './_components/skills-github-section'
import { SkillsHero } from './_components/skills-hero'
import { SkillsSalesCopy } from './_components/skills-sales-copy'

// No `force-dynamic`. It was carried over with a comment about cohort
// enrollment windows, but this page never reads a cohort — every reader on it
// is cached and tag-invalidated. Reading `searchParams` for the changelog
// pager already opts the route out of static rendering where it matters, and
// dropping the flag lets the cached readers actually be cached.

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

type Props = {
	searchParams: Promise<{ page?: string }>
}

/**
 * /skills — the skill system's own page (`Skills Page.dc.html`).
 *
 * The order is the argument: what you get and how to install it (HEAD), what
 * a skill even is (WHAT A SKILL IS), the catalog (THE SKILL SET), what changed
 * (CHANGELOG), and the ask restated at the bottom (GET THE SKILLS).
 *
 * Every count, group, order and description on the page is CMS or GitHub data.
 * The list (`SKILLS_LIST_ID`) owns the grouping AND the order of the groups —
 * to lead with "The Main Flow" rather than "Getting Started", move the section
 * in the list, not in this file.
 */
export default async function SkillsPage({ searchParams }: Props) {
	const { page: pageParam } = await searchParams
	// Floored, not just clamped: `?page=1.05` would otherwise reach the query as
	// a fractional OFFSET, which the driver rejects — a hand-typed URL should
	// land on a page, not a 500.
	// `?page=Infinity` and `?page=1e309` both survive `Math.floor` and a
	// `|| 1` guard (Infinity is truthy), reaching the query as a non-finite
	// OFFSET. Anything that is not a plain in-range integer falls back to 1.
	const requestedPage = Math.floor(Number(pageParam ?? '1'))
	const currentPage =
		Number.isSafeInteger(requestedPage) && requestedPage >= 1
			? requestedPage
			: 1
	const offset = (currentPage - 1) * SKILLS_PAGE_SIZE
	const [entries, totalEntries, skillsList, stars, latestEntry] =
		await Promise.all([
			getSkillChangelogEntries({ limit: SKILLS_PAGE_SIZE, offset }),
			getSkillChangelogCount(),
			getListWithSections(SKILLS_LIST_ID),
			getRepoStarCount(SKILLS_HERO.repoOwner, SKILLS_HERO.repoName),
			// The head's "latest release" stat. Page 2 shows older entries, so the
			// newest one is fetched separately rather than read off `entries`.
			getSkillChangelogEntries({ limit: 1, offset: 0 }),
		])

	const skillGroups = toSkillGroups(skillsList?.resources)
	const skillCount = skillGroups.reduce(
		(total, group) => total + group.skills.length,
		0,
	)
	const totalPages = Math.max(Math.ceil(totalEntries / SKILLS_PAGE_SIZE), 1)
	const changelogItems = entries.map(toChangelogItem)
	const latestVersion = latestEntry[0]
		? toChangelogItem(latestEntry[0]).version
		: null

	return (
		<LayoutClient withContainer withFooter={false}>
			<HubLayout>
				<main className="bg-background text-foreground">
					<SkillsHero
						stars={stars}
						skillCount={skillCount}
						latestVersion={latestVersion}
					/>

					<SkillsSalesCopy />

					<SkillSet groups={skillGroups} skillCount={skillCount} />

					<section aria-labelledby="changelog-heading" className="border-b">
						<div className="px-[18px] pb-[50px] pt-12 sm:px-11">
							<div className="mb-[26px] flex flex-col gap-4 md:flex-row md:items-end">
								<div>
									<p
										className={cn(
											TYPE.micro,
											'text-[color:var(--ah-fg-label)]',
										)}
									>
										Changelog
									</p>
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
							<ChangelogList items={changelogItems} />
							<ChangelogPagination
								currentPage={currentPage}
								totalPages={totalPages}
							/>
						</div>
					</section>

					<SkillsGitHubSection stars={stars} />

					<CompanyLogoGrid
						variant="row"
						eyebrow="Engineers from"
						className="border-border border-b px-[18px] py-[22px] sm:px-11"
					/>
				</main>
			</HubLayout>
		</LayoutClient>
	)
}

type ListItem = {
	resource?: {
		id?: string
		type?: string
		fields?: Record<string, unknown> | null
		resources?: ListItem[] | null
	} | null
}

function isPublicPublished(fields?: Record<string, unknown> | null) {
	return fields?.state === 'published' && fields?.visibility === 'public'
}

function stringField(
	fields: Record<string, unknown> | null | undefined,
	key: string,
): string | undefined {
	const value = fields?.[key]
	return typeof value === 'string' && value ? value : undefined
}

function toSkillItem(item: ListItem) {
	const fields = item.resource?.fields
	const slug = stringField(fields, 'slug')
	if (!slug) return null
	return {
		slug,
		title: stringField(fields, 'title') ?? slug,
		description: stringField(fields, 'description'),
	}
}

// Walk the /skills list into ordered render groups. A `section` resource
// becomes a titled group of its published/public child skills; anything else
// collapses into an untitled run of loose skills. Empty sections are dropped so
// an unpopulated (or fully-unpublished) section leaves no orphan heading.
function toSkillGroups(resources?: ListItem[] | null): SkillSetGroup[] {
	const groups: SkillSetGroup[] = []
	let looseRun: SkillSetGroup | null = null

	for (const item of resources ?? []) {
		if (item.resource?.type === 'section') {
			// Sections are purely structural — their own state/visibility is
			// ignored (they're created draft+unlisted with no publish UI). Their
			// published/public children drive whether the section shows at all.
			const skills = (item.resource.resources ?? [])
				.filter((child) => isPublicPublished(child.resource?.fields))
				.map(toSkillItem)
				.filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
			if (skills.length === 0) continue
			looseRun = null
			groups.push({
				id: item.resource.id ?? skills[0]!.slug,
				title: stringField(item.resource.fields, 'title') ?? 'Skills',
				description: stringField(item.resource.fields, 'description'),
				skills,
			})
			continue
		}
		if (!isPublicPublished(item.resource?.fields)) continue
		const skill = toSkillItem(item)
		if (!skill) continue
		if (!looseRun) {
			looseRun = { id: `loose-${groups.length}`, title: null, skills: [] }
			groups.push(looseRun)
		}
		looseRun.skills.push(skill)
	}

	return groups
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
