import type { Metadata } from 'next'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { Resource } from '@/components/landing/resource'
import { SectionHeading } from '@/components/landing/section-heading'
import LayoutClient from '@/components/layout-client'
import { getSubscriberFromCookie } from '@/lib/convertkit'
import { getList } from '@/lib/lists-query'
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
		getList(SKILLS_LIST_ID),
	])
	const skillPostSlugs =
		skillsList?.resources
			?.filter(isPublicPublishedListResource)
			.map((item) => item.resource?.fields?.slug)
			.filter((slug): slug is string => Boolean(slug)) ?? []
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
						{skillPostSlugs.map((slug) => (
							<Resource key={slug} slugOrId={slug} variant="row" />
						))}
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

function isPublicPublishedListResource(item: {
	resource?: { fields?: Record<string, unknown> | null } | null
}) {
	return (
		item.resource?.fields?.state === 'published' &&
		item.resource?.fields?.visibility === 'public'
	)
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
