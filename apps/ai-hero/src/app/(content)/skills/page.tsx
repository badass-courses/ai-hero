import type { Metadata } from 'next'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { Resource } from '@/components/landing/resource'
import { SectionHeading } from '@/components/landing/section-heading'
import LayoutClient from '@/components/layout-client'
import { getSubscriberFromCookie } from '@/lib/convertkit'
import { getListWithSections } from '@/lib/lists-query'
import {
	getSkillChangelogCount,
	getSkillChangelogEntries,
	type SkillChangelogEntry,
} from '@/lib/skill-changelog-query'
import {
	SKILLS_GUIDE_ITEMS,
	SKILLS_HERO,
	SKILLS_LIST_ID,
	SKILLS_PAGE_SIZE,
} from '@/lib/skills-content'
import { RssIcon } from 'lucide-react'

import { ChangelogList, type ChangelogItem } from './_components/changelog-list'
import { ChangelogPagination } from './_components/changelog-pagination'
import { GuideGrid } from './_components/guide-grid'
import { SkillsGitHubSection } from './_components/skills-github-section'
import { SkillsHero } from './_components/skills-hero'
import { type SkillsNewsletterStatus } from './_components/skills-newsletter'

export const dynamic = 'force-dynamic'

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
	searchParams: Promise<{ page?: string; preview?: string }>
}

export default async function SkillsPage({ searchParams }: Props) {
	const { page: pageParam, preview } = await searchParams
	const currentPage = Math.max(Number(pageParam ?? '1') || 1, 1)
	const offset = (currentPage - 1) * SKILLS_PAGE_SIZE
	const [entries, totalEntries, subscriber, skillsList] = await Promise.all([
		getSkillChangelogEntries({ limit: SKILLS_PAGE_SIZE, offset }),
		getSkillChangelogCount(),
		getSubscriberFromCookie(),
		getListWithSections(SKILLS_LIST_ID),
	])
	const skillGroups = toSkillGroups(skillsList?.resources)
	const totalPages = Math.max(Math.ceil(totalEntries / SKILLS_PAGE_SIZE), 1)
	const changelogItems = entries.map(toChangelogItem)
	const newsletterState: SkillsNewsletterStatus =
		preview === 'form'
			? 'show-form'
			: preview === 'tag-me'
				? 'tag-me'
				: !subscriber
					? 'show-form'
					: subscriber.fields?.interest === 'skills'
						? 'subscribed'
						: 'tag-me'

	return (
		<LayoutClient withContainer>
			<main className="bg-background text-foreground">
				<SkillsHero newsletterState={newsletterState} />

				<section aria-labelledby="skill-set-heading" className="border-b">
					<SectionHeading>
						<span id="skill-set-heading">The skill set</span>
					</SectionHeading>
					<div>
						{skillGroups.map((group) =>
							group.kind === 'section' ? (
								<div key={group.id}>
									<div className="px-8 pt-10 pb-4">
										<h3 className="text-foreground text-3xl sm:text-4xl font-semibold">
											{group.title}
										</h3>
										{group.description ? (
											<p className="text-foreground/60 mt-2 max-w-2xl text-balance lg:text-lg sm:text-base text-sm leading-relaxed">
												{group.description}
											</p>
										) : null}
									</div>
									{group.slugs.map((slug) => (
										<Resource key={slug} slugOrId={slug} variant="row" />
									))}
								</div>
							) : (
								<Resource
									key={group.slug}
									slugOrId={group.slug}
									variant="row"
								/>
							),
						)}
					</div>
				</section>

				<section aria-labelledby="get-oriented-heading" className="border-b">
					<SectionHeading>
						<span id="get-oriented-heading">Get oriented</span>
					</SectionHeading>
					<GuideGrid items={[...SKILLS_GUIDE_ITEMS]} />
				</section>

				<section aria-labelledby="changelog-heading" className="border-b">
					<SectionHeading>
						<span className="inline-flex items-center justify-center gap-3">
							<span id="changelog-heading">Changelog</span>
							<a
								href="/skills/rss.xml"
								className="border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium tracking-tight transition"
							>
								<RssIcon className="h-4 w-4" aria-hidden />
								RSS
							</a>
						</span>
					</SectionHeading>
					<ChangelogList items={changelogItems} />
					<ChangelogPagination
						currentPage={currentPage}
						totalPages={totalPages}
					/>
				</section>

				<SkillsGitHubSection />
				<CompanyLogoGrid className="border-t pt-6" />
			</main>
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

type SkillGroup =
	| { kind: 'skill'; slug: string }
	| {
			kind: 'section'
			id: string
			title: string
			description?: string
			slugs: string[]
	  }

function isPublicPublished(fields?: Record<string, unknown> | null) {
	return fields?.state === 'published' && fields?.visibility === 'public'
}

function slugOf(item: ListItem): string | undefined {
	const slug = item.resource?.fields?.slug
	return typeof slug === 'string' && slug ? slug : undefined
}

// Walk the /skills list into ordered render groups. A `section` resource
// becomes a titled sub-group of its published/public child skills; anything
// else renders as a loose skill row. Empty sections are dropped so an
// unpopulated (or fully-unpublished) section leaves no orphan heading.
function toSkillGroups(resources?: ListItem[] | null): SkillGroup[] {
	const groups: SkillGroup[] = []
	for (const item of resources ?? []) {
		if (item.resource?.type === 'section') {
			// Sections are purely structural — their own state/visibility is
			// ignored (they're created draft+unlisted with no publish UI). Their
			// published/public children drive whether the section shows at all.
			const slugs =
				item.resource.resources
					?.filter((child) => isPublicPublished(child.resource?.fields))
					.map(slugOf)
					.filter((slug): slug is string => Boolean(slug)) ?? []
			if (slugs.length === 0) continue
			const title = item.resource.fields?.title
			const description = item.resource.fields?.description
			groups.push({
				kind: 'section',
				id: item.resource.id ?? slugs[0]!,
				title: typeof title === 'string' ? title : 'Skills',
				description:
					typeof description === 'string' && description
						? description
						: undefined,
				slugs,
			})
			continue
		}
		if (!isPublicPublished(item.resource?.fields)) continue
		const slug = slugOf(item)
		if (slug) groups.push({ kind: 'skill', slug })
	}
	return groups
}

function toChangelogItem(entry: SkillChangelogEntry): ChangelogItem {
	const title = String(entry.fields?.title ?? 'Untitled skill update')
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
		title,
		description: description ? String(description) : undefined,
		publishedAt,
	}
}
