import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))
vi.mock('@/db/schema', () => ({
	contentResource: 'ContentResource',
	contentResourceResource: 'ContentResourceResource',
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/lib/ai-coding-dictionary', () => ({
	getAiCodingDictionary: async () => ({ updatedAt: '2026-10-01', entries: [] }),
}))
vi.mock('@/lib/skill-changelog-query', () => ({
	getSkillChangelogEntries: async () => [],
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
					{
						slug: 'newsletter',
						updatedAt: '2026-10-13T00:00:00Z',
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
		).toBe('2026-10-13T00:00:00.000Z')
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
	it('does not emit drafts or unpublished/unlisted content', async () => {
		const urls = (await sitemap()).map((entry) => entry.url)
		expect(urls).not.toContain('https://www.aihero.dev/draft-post')
		expect(urls).not.toContain('https://www.aihero.dev/unlisted-post')
	})
})
