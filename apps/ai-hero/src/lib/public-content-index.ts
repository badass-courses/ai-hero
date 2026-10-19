import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { getAiCodingDictionary } from '@/lib/ai-coding-dictionary'
import {
	getSandcastleDocs,
	SANDCASTLE_DOCS_CACHE_TAG,
	SANDCASTLE_DOCS_PATH,
} from '@/lib/sandcastle-docs'
import { getSkillChangelogEntries } from '@/lib/skill-changelog-query'
import {
	SKILL_CHANGELOG_RESOURCE_TYPE,
	SKILL_CHANGELOG_SLUG_PREFIX,
} from '@/lib/skill-changelog-types'
import { retryTransientDatabaseRead } from '@/lib/transient-database-read'
import { sql } from 'drizzle-orm'
import { unstable_cache } from 'next/cache'

interface SitemapEntry {
	url: string
	title: string
	description: string
	lastModified?: Date
	changeFrequency:
		| 'yearly'
		| 'monthly'
		| 'weekly'
		| 'daily'
		| 'hourly'
		| 'always'
		| 'never'
	priority: number
}

function toValidDate(value: unknown): Date | null {
	if (!value) return null

	const date = value instanceof Date ? value : new Date(String(value))

	return Number.isNaN(date.getTime()) ? null : date
}

function contentTimestamp(...values: unknown[]): Date | undefined {
	for (const value of values) {
		const date = toValidDate(value)
		if (date) return date
	}

	return undefined
}

function latestTimestamp(values: unknown[]): Date | undefined {
	const dates = values
		.map(toValidDate)
		.filter((date): date is Date => date !== null)
	return dates.length
		? new Date(Math.max(...dates.map((date) => date.getTime())))
		: undefined
}

type IndexMode = 'sitemap' | 'feed'

// RSS compatibility only: preserve main's static-date fallback; never use it for sitemap lastmod.
function feedStaticTimestamp() {
	return contentTimestamp(
		process.env.DEPLOY_TIMESTAMP,
		process.env.VERCEL_GIT_COMMIT_SHA,
		'2026-05-16',
	)!
}

async function buildIndex(mode: IndexMode): Promise<SitemapEntry[]> {
	const publicationDate = (
		updated: unknown,
		published: unknown,
		created: unknown,
		...fallback: unknown[]
	) =>
		contentTimestamp(
			...(mode === 'feed'
				? [published, updated, created]
				: [updated, published, created]),
			...fallback,
		) ?? (mode === 'feed' ? new Date(0) : undefined)
	const workshopItems = await db.execute(sql`
    SELECT DISTINCT
      workshop.id AS workshop_id,
      workshop.type AS workshop_type,
      workshop.fields->>'$.state' AS workshop_state,
      workshop.fields->>'$.visibility' AS workshop_visibility,
      workshop.fields->>'$.slug' AS workshop_slug,
      workshop.fields->>'$.title' AS workshop_title,
      workshop.fields->>'$.description' AS workshop_description,
      workshop.fields->>'$.publishedAt' AS workshop_publishedAt,
      workshop.updatedAt AS workshop_updatedAt,
      workshop.createdAt AS workshop_createdAt,
      COALESCE(sections.id, top_level_lessons.id) AS section_or_lesson_id,
      COALESCE(sections.fields->>'$.slug', top_level_lessons.fields->>'$.slug') AS section_or_lesson_slug,
      COALESCE(sections.fields->>'$.title', top_level_lessons.fields->>'$.title') AS section_or_lesson_title,
      COALESCE(section_relations.position, top_level_lesson_relations.position) AS section_or_lesson_position,
      CASE
          WHEN COALESCE(sections.id, top_level_lessons.id) IS NULL THEN workshop.type
          WHEN lessons.id IS NULL THEN top_level_lessons.\`type\`
          ELSE lessons.\`type\`
      END AS item_type,
      lessons.id AS lesson_id,
      lessons.fields->>'$.slug' AS lesson_slug,
      lessons.fields->>'$.title' AS lesson_title,
      lessons.fields->>'$.description' AS lesson_description,
      lesson_relations.position AS lesson_position,
      COALESCE(lessons.fields->>'$.publishedAt', top_level_lessons.fields->>'$.publishedAt') AS lesson_publishedAt,
      COALESCE(lessons.fields->>'$.state', top_level_lessons.fields->>'$.state') AS lesson_state,
      COALESCE(lessons.fields->>'$.visibility', top_level_lessons.fields->>'$.visibility') AS lesson_visibility,
      COALESCE(lessons.updatedAt, top_level_lessons.updatedAt) AS lesson_updatedAt,
      COALESCE(lessons.createdAt, top_level_lessons.createdAt) AS lesson_createdAt
    FROM
      ${contentResource} AS workshop
    LEFT JOIN ${contentResourceResource} AS section_relations
      ON workshop.id = section_relations.resourceOfId
    LEFT JOIN ${contentResource} AS sections
      ON sections.id = section_relations.resourceId AND sections.type = 'section'
      ${mode === 'sitemap' ? sql`AND sections.deletedAt IS NULL` : sql``}
    LEFT JOIN ${contentResourceResource} AS lesson_relations
      ON sections.id = lesson_relations.resourceOfId
    LEFT JOIN ${contentResource} AS lessons
      ON lessons.id = lesson_relations.resourceId AND (lessons.type = 'lesson' OR lessons.type = 'exercise')
      ${mode === 'sitemap' ? sql`AND lessons.deletedAt IS NULL` : sql``}
    LEFT JOIN ${contentResourceResource} AS top_level_lesson_relations
      ON workshop.id = top_level_lesson_relations.resourceOfId
    LEFT JOIN ${contentResource} AS top_level_lessons
      ON top_level_lessons.id = top_level_lesson_relations.resourceId
      ${mode === 'sitemap' ? sql`AND top_level_lessons.deletedAt IS NULL` : sql``}
      AND (top_level_lessons.type = 'lesson' OR top_level_lessons.type = 'exercise')
    WHERE
      (workshop.type = 'workshop' OR workshop.\`type\` = 'tutorial')
      AND workshop.fields->>'$.state' = 'published'
      AND workshop.fields->>'$.visibility' = 'public'
      ${mode === 'sitemap' ? sql`AND workshop.deletedAt IS NULL` : sql``}
    ORDER BY
      COALESCE(section_relations.position, top_level_lesson_relations.position),
      lesson_relations.position
  `)

	const sitemapEntries: SitemapEntry[] = []

	// Add workshop and tutorial entries
	const workshopsAndTutorials = new Set<string>()
	workshopItems.rows.forEach((item: any) => {
		if (
			item.workshop_state !== 'published' ||
			item.workshop_visibility !== 'public'
		)
			return
		if (!workshopsAndTutorials.has(item.workshop_id)) {
			workshopsAndTutorials.add(item.workshop_id)
			sitemapEntries.push({
				url: `${process.env.COURSEBUILDER_URL}/${item.workshop_type}s/${item.workshop_slug}`,
				title: item.workshop_title,
				description: item.workshop_description || '',
				lastModified: publicationDate(
					item.workshop_updatedAt,
					item.workshop_publishedAt,
					item.workshop_createdAt,
				),
				changeFrequency: 'monthly',
				priority: 0.9,
			})
		}
	})

	// Add lesson and exercise entries
	workshopItems.rows.forEach((item: any) => {
		if (
			item.workshop_state !== 'published' ||
			item.workshop_visibility !== 'public'
		)
			return
		if (item.item_type === 'lesson' || item.item_type === 'exercise') {
			const slug = item.lesson_slug || item.section_or_lesson_slug
			const isPublicLesson =
				item.lesson_state === 'published' && item.lesson_visibility === 'public'
			if (slug && isPublicLesson) {
				sitemapEntries.push({
					url: `${process.env.COURSEBUILDER_URL}/${item.workshop_type}s/${item.workshop_slug}/${slug}`,
					title: item.lesson_title || item.section_or_lesson_title,
					description: item.lesson_description || '',
					lastModified: publicationDate(
						item.lesson_updatedAt,
						item.lesson_publishedAt,
						item.lesson_createdAt,
						item.workshop_publishedAt,
						item.workshop_updatedAt,
						item.workshop_createdAt,
					),
					changeFrequency: 'monthly',
					priority: 0.7,
				})
			}
		}
	})

	// Add other content types (posts)
	const otherContentItems = await db.execute(sql`
	SELECT
		cr.id,
		cr.type,
		cr.fields->>'$.slug' AS slug,
		cr.fields->>'$.title' AS title,
		cr.fields->>'$.description' AS description,
		cr.fields->>'$.state' AS state,
		cr.fields->>'$.visibility' AS visibility,
		cr.fields->>'$.publishedAt' AS publishedAt,
		cr.updatedAt,
		cr.createdAt
	FROM
		${contentResource} cr
	WHERE
		cr.type IN ('post', 'list')
		AND cr.fields->>'$.state' = 'published'
		AND cr.fields->>'$.visibility' = 'public'
		AND cr.deletedAt IS NULL
	ORDER BY
		cr.type, cr.updatedAt DESC
	`)

	otherContentItems.rows.forEach((item: any) => {
		if (item.state !== 'published' || item.visibility !== 'public') return
		let url: string
		let priority: number
		let changeFrequency:
			| 'yearly'
			| 'monthly'
			| 'weekly'
			| 'daily'
			| 'hourly'
			| 'always'
			| 'never'

		switch (item.type) {
			case 'post':
				url = `${process.env.COURSEBUILDER_URL}/${item.slug}`
				priority = 0.8
				changeFrequency = 'weekly'
				break
			case 'list':
				url = `${process.env.COURSEBUILDER_URL}/${item.slug}`
				priority = 0.8
				changeFrequency = 'weekly'
				break
			default:
				return // Skip unknown types
		}

		sitemapEntries.push({
			url,
			title: item.title,
			description: item.description || '',
			lastModified: publicationDate(
				item.updatedAt,
				item.publishedAt,
				item.createdAt,
			),
			changeFrequency,
			priority,
		})
	})

	const dictionary = await getAiCodingDictionary()

	sitemapEntries.push({
		url: `${process.env.COURSEBUILDER_URL}/ai-coding-dictionary`,
		title: 'AI Coding Dictionary',
		description:
			'The vocabulary of AI coding, translated into plain English for engineers.',
		lastModified: new Date(dictionary.updatedAt),
		changeFrequency: 'daily',
		priority: 0.8,
	})

	dictionary.entries.forEach((entry) => {
		sitemapEntries.push({
			url: `${process.env.COURSEBUILDER_URL}/ai-coding-dictionary/${entry.slug}`,
			title: `${entry.title} | AI Coding Dictionary`,
			description: entry.description,
			lastModified: new Date(dictionary.updatedAt),
			changeFrequency: 'daily',
			priority: 0.7,
		})
	})

	// Docs pages, not publications: the sitemap lists them, the feed does not.
	// The README carries no date, so there is no honest lastModified to give.
	// The README is a GitHub fetch: when it fails, only these entries drop out.
	const sandcastle =
		mode === 'sitemap' ? await getSandcastleDocs().catch(() => null) : null
	if (sandcastle) {
		sitemapEntries.push({
			url: `${process.env.COURSEBUILDER_URL}${SANDCASTLE_DOCS_PATH}`,
			title: 'Sandcastle',
			description: sandcastle.lead,
			changeFrequency: 'weekly',
			priority: 0.7,
		})
		sandcastle.pages.forEach((page) => {
			sitemapEntries.push({
				url: `${process.env.COURSEBUILDER_URL}${page.href}`,
				title: `${page.title} | Sandcastle docs`,
				description: page.description,
				changeFrequency: 'weekly',
				priority: 0.6,
			})
		})
	}

	// Static route bodies can have CMS backing; never substitute a deployment date.
	const pageItems =
		mode === 'feed'
			? { rows: [] }
			: await db.execute(sql`
		SELECT cr.fields->>'$.slug' AS slug, cr.updatedAt
		FROM ${contentResource} cr
		WHERE cr.type = 'page' AND cr.fields->>'$.state' = 'published'
			AND cr.deletedAt IS NULL
			AND cr.fields->>'$.slug' IN ('landing-page-v2', 'landing-page')
		UNION ALL
		SELECT 'skills-children' AS slug, MAX(cr.updatedAt) AS updatedAt
		FROM ${contentResource} cr
		WHERE cr.fields->>'$.state' = 'published' AND cr.fields->>'$.visibility' = 'public'
			AND cr.deletedAt IS NULL
			AND (cr.type = ${SKILL_CHANGELOG_RESOURCE_TYPE} OR
				(cr.type = 'post' AND (cr.fields->>'$.postType' = ${SKILL_CHANGELOG_RESOURCE_TYPE}
					OR cr.fields->>'$.slug' LIKE ${`${SKILL_CHANGELOG_SLUG_PREFIX}%`})))
	`)
	const pageUpdatedAt = (slug: string) =>
		toValidDate(
			pageItems.rows.find((item: any) => item.slug === slug)?.updatedAt,
		) ?? undefined
	const skillChangelogEntries = await getSkillChangelogEntries({ limit: 100 })
	const skillsUpdatedAt = pageUpdatedAt('skills-children')
	const staticAcquisitionEntries: SitemapEntry[] = [
		{
			url: `${process.env.COURSEBUILDER_URL}/newsletter`,
			title: 'AI Hero Newsletter by Matt Pocock',
			description:
				'Subscribe to be the first to learn about AI Hero releases, updates, and special discounts for AI Heroes.',
			lastModified: mode === 'feed' ? feedStaticTimestamp() : undefined,
			changeFrequency: 'weekly',
			priority: 0.8,
		},
		{
			url: `${process.env.COURSEBUILDER_URL}/skills`,
			title: 'AI Skills for Real Engineers',
			description:
				'A practical skill system for engineers who want to use AI without giving up their standards.',
			lastModified: mode === 'feed' ? feedStaticTimestamp() : skillsUpdatedAt,
			changeFrequency: 'weekly',
			priority: 0.9,
		},
		{
			url: `${process.env.COURSEBUILDER_URL}/skills/subscribe`,
			title: 'Skills Newsletter',
			description:
				'A practical skill system for engineers who want to use AI without giving up their standards.',
			lastModified: mode === 'feed' ? feedStaticTimestamp() : undefined,
			changeFrequency: 'weekly',
			priority: 0.8,
		},
	]

	const seenSkillSlugs = new Set<string>()

	skillChangelogEntries.forEach((entry) => {
		const slug = entry.fields?.slug
		if (!slug) return
		if (seenSkillSlugs.has(slug)) return
		seenSkillSlugs.add(slug)

		sitemapEntries.push({
			url: `${process.env.COURSEBUILDER_URL}/skills/${slug}`,
			title: String(entry.fields?.title ?? 'AI Skills Changelog'),
			description: String(
				entry.fields?.description || entry.fields?.summary || '',
			),
			lastModified: contentTimestamp(entry.updatedAt, entry.createdAt),
			changeFrequency: 'weekly',
			priority: 0.7,
		})
	})

	// Add the homepage and static acquisition pages
	sitemapEntries.unshift(
		{
			url: `${process.env.COURSEBUILDER_URL}/`,
			title: 'Homepage',
			description: '',
			lastModified:
				mode === 'feed'
					? feedStaticTimestamp()
					: (pageUpdatedAt('landing-page-v2') ??
						pageUpdatedAt('landing-page') ??
						latestTimestamp(sitemapEntries.map((entry) => entry.lastModified))),
			changeFrequency: 'daily',
			priority: 1,
		},
		...staticAcquisitionEntries,
	)

	return sitemapEntries
}

const getCachedIndex = unstable_cache(
	async (mode: IndexMode) => retryTransientDatabaseRead(() => buildIndex(mode)),
	['public-content-index-v3'],
	{
		revalidate: 3600,
		tags: [
			'posts',
			'lists',
			'tags',
			'pages',
			'workshop',
			'skill-changelog',
			'ai-coding-dictionary',
			SANDCASTLE_DOCS_CACHE_TAG,
		],
	},
)

export async function getPublicSitemapEntries(): Promise<SitemapEntry[]> {
	const entries = await getCachedIndex('sitemap')
	return entries.map((entry) => ({
		...entry,
		...(entry.lastModified
			? { lastModified: new Date(entry.lastModified) }
			: {}),
	}))
}

/** Preserve publication-first feed dates and inventory independently of sitemap update dates. */
export async function getPublicFeedEntries() {
	return (await getCachedIndex('feed')).map((entry) => ({
		...entry,
		lastModified: new Date(entry.lastModified ?? 0),
	}))
}
