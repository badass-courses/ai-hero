import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentResourceSchema } from '@coursebuilder/core/schemas'

const mocks = vi.hoisted(() => ({
	execute: vi.fn(),
	skills: vi.fn(),
	sandcastle: vi.fn(),
}))
vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))
vi.mock('@/db/schema', () => ({
	contentResource: 'ContentResource',
	contentResourceResource: 'ContentResourceResource',
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/lib/ai-coding-dictionary', () => ({
	getAiCodingDictionary: async () => ({ updatedAt: '2026-10-01', entries: [] }),
}))
vi.mock('@/lib/sandcastle-docs', () => ({
	SANDCASTLE_DOCS_CACHE_TAG: 'sandcastle-docs',
	SANDCASTLE_DOCS_PATH: '/sandcastle',
	getSandcastleDocs: mocks.sandcastle,
}))
vi.mock('@/lib/skill-changelog-query', () => ({
	getSkillChangelogEntries: mocks.skills,
}))
import sitemap from './sitemap'

const published = {
	state: 'published',
	visibility: 'public',
	updatedAt: '2026-10-15T00:00:00Z',
	publishedAt: '2026-01-01T00:00:00Z',
	type: 'post',
	slug: 'public-post',
	title: 'Public',
}

describe('content-derived sitemap timestamps', () => {
	beforeEach(() => {
		mocks.sandcastle.mockResolvedValue({
			lead: 'A library.',
			pages: [
				{
					title: 'Quick start',
					slug: 'quick-start',
					href: '/sandcastle/quick-start',
					description: '',
				},
			],
		})
		mocks.skills.mockReset().mockResolvedValue([])
		vi.stubEnv('COURSEBUILDER_URL', 'https://www.aihero.dev')
		mocks.execute.mockReset()
		mocks.execute
			.mockResolvedValueOnce({ rows: [] })
			.mockResolvedValueOnce({
				rows: [
					published,
					{ ...published, slug: 'draft-post', state: 'draft' },
					{ ...published, slug: 'unlisted-post', visibility: 'unlisted' },
				],
			})
			.mockResolvedValueOnce({
				rows: [
					{
						slug: 'landing-page-v2',
						updatedAt: '2026-10-14T00:00:00Z',
						state: 'published',
					},
					{ slug: 'skills-children', updatedAt: '2026-10-16T00:00:00Z' },
				],
			})
	})
	it('uses updatedAt rather than publishedAt, build time or a constant date', async () => {
		const entries = await sitemap()
		expect(
			entries
				.find((entry) => entry.url.endsWith('/public-post'))
				?.lastModified?.toISOString(),
		).toBe('2026-10-15T00:00:00.000Z')
		expect(
			entries
				.find((entry) => entry.url === 'https://www.aihero.dev/')
				?.lastModified?.toISOString(),
		).toBe('2026-10-14T00:00:00.000Z')
		expect(
			entries
				.find((entry) => entry.url.endsWith('/newsletter'))
				?.lastModified?.toISOString(),
		).toBeUndefined()
		expect(
			entries
				.find((entry) => entry.url.endsWith('/skills'))
				?.lastModified?.toISOString(),
		).toBe('2026-10-16T00:00:00.000Z')
		expect(
			entries.find((entry) => entry.url.endsWith('/skills/subscribe'))
				?.lastModified,
		).toBeUndefined()
	})
	it('excludes draft workshops and lessons and uses lesson updates', async () => {
		const workshop = {
			workshop_id: 'w',
			workshop_slug: 'course',
			workshop_type: 'workshop',
			workshop_state: 'published',
			workshop_visibility: 'public',
			workshop_updatedAt: '2026-10-12',
			workshop_publishedAt: '2026-01-01',
		}
		mocks.execute.mockReset()
		mocks.execute
			.mockResolvedValueOnce({
				rows: [
					{
						...workshop,
						workshop_id: 'draft',
						workshop_slug: 'draft-course',
						workshop_state: 'draft',
					},
					{
						...workshop,
						item_type: 'lesson',
						lesson_slug: 'draft-lesson',
						lesson_state: 'draft',
						lesson_visibility: 'public',
					},
					{
						...workshop,
						item_type: 'lesson',
						lesson_slug: 'lesson',
						lesson_state: 'published',
						lesson_visibility: 'public',
						lesson_updatedAt: '2026-10-13',
						lesson_publishedAt: '2026-01-02',
					},
				],
			})
			.mockResolvedValueOnce({ rows: [] })
			.mockResolvedValueOnce({ rows: [] })
		const entries = await sitemap()
		expect(
			entries
				.find((entry) => entry.url.endsWith('/course'))
				?.lastModified?.toISOString(),
		).toBe('2026-10-12T00:00:00.000Z')
		expect(
			entries
				.find((entry) => entry.url.endsWith('/course/lesson'))
				?.lastModified?.toISOString(),
		).toBe('2026-10-13T00:00:00.000Z')
		expect(entries.some((entry) => entry.url.includes('draft'))).toBe(false)
	})
	it('keeps skill URLs from query-shaped resources without re-filtering their fields', async () => {
		const skill = ContentResourceSchema.parse({
			id: 'synthetic-skill',
			type: 'skill-changelog',
			createdById: 'synthetic-author',
			organizationId: null,
			createdByOrganizationMembershipId: null,
			createdAt: '2030-01-01',
			updatedAt: '2030-02-01',
			deletedAt: null,
			resources: [],
			fields: {
				slug: 'synthetic-skill',
				title: 'Synthetic skill',
				description: 'Skill update',
			},
		})
		mocks.skills.mockResolvedValueOnce([
			skill,
			{
				...skill,
				id: 'second',
				fields: { slug: 'second-skill', title: 'Second skill' },
			},
		])
		const urls = (await sitemap()).map((entry) => entry.url)
		expect(urls).toContain('https://www.aihero.dev/skills/synthetic-skill')
		expect(urls).toContain('https://www.aihero.dev/skills/second-skill')
	})
	it('lists every Sandcastle docs page without inventing a date', async () => {
		const entries = await sitemap()
		const docs = entries.filter((entry) => entry.url.includes('/sandcastle'))
		expect(docs.map((entry) => entry.url)).toEqual([
			'https://www.aihero.dev/sandcastle',
			'https://www.aihero.dev/sandcastle/quick-start',
		])
		expect(docs.every((entry) => entry.lastModified === undefined)).toBe(true)
	})
	it('drops only the Sandcastle entries when the README fetch fails', async () => {
		mocks.sandcastle.mockRejectedValue(
			new Error('raw.githubusercontent.com 503'),
		)
		const urls = (await sitemap()).map((entry) => entry.url)
		expect(urls.some((url) => url.includes('/sandcastle'))).toBe(false)
		expect(urls).toContain('https://www.aihero.dev/public-post')
	})
	it('does not emit drafts or unpublished/unlisted content', async () => {
		const urls = (await sitemap()).map((entry) => entry.url)
		expect(urls).not.toContain('https://www.aihero.dev/draft-post')
		expect(urls).not.toContain('https://www.aihero.dev/unlisted-post')
	})
})
