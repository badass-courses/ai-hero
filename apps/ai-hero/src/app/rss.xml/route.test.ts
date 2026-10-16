import { describe, expect, it, vi } from 'vitest'
import { Feed } from 'feed'
import ts from 'typescript'
import baseline from '@/lib/__fixtures__/rss-main.json'

const fixture = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute: fixture.execute } }))
vi.mock('@/db/schema', () => ({
	contentResource: 'ContentResource',
	contentResourceResource: 'ContentResourceResource',
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/env.mjs', () => ({
	env: {
		NEXT_PUBLIC_URL: 'https://www.aihero.dev',
		COURSEBUILDER_URL: 'https://www.aihero.dev',
		NEXT_PUBLIC_SITE_TITLE: 'AI Hero',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test',
	},
}))
vi.mock('@/lib/ai-coding-dictionary', () => ({
	getAiCodingDictionary: async () => ({ updatedAt: '2026-01-10', entries: [] }),
}))
vi.mock('@/lib/skill-changelog-query', () => ({
	getSkillChangelogEntries: async () => [],
}))
import config from '@/config'
import { env } from '@/env.mjs'
import { GET } from './route'

const site = 'https://www.aihero.dev'
const entry = (
	path: string,
	title: string,
	description: string,
	date: string,
) => ({
	url: `${site}${path}`,
	title,
	description,
	lastModified: new Date(date),
})
const mainIndexFixture = [
	entry('/', 'Homepage', '', '2026-05-16'),
	entry(
		'/newsletter',
		'AI Hero Newsletter by Matt Pocock',
		'Subscribe to be the first to learn about AI Hero releases, updates, and special discounts for AI Heroes.',
		'2026-05-16',
	),
	entry(
		'/skills',
		'AI Skills for Real Engineers',
		'A practical skill system for engineers who want to use AI without giving up their standards.',
		'2026-05-16',
	),
	entry(
		'/skills/subscribe',
		'Skills Newsletter',
		'A practical skill system for engineers who want to use AI without giving up their standards.',
		'2026-05-16',
	),
	entry('/workshops/course', 'Course', 'Course description', '2026-01-01'),
	entry(
		'/workshops/course/lesson',
		'Lesson',
		'Lesson description',
		'2026-01-02',
	),
	entry('/post', 'Post', 'Post description', '2026-02-01'),
	entry(
		'/ai-coding-dictionary',
		'AI Coding Dictionary',
		'The vocabulary of AI coding, translated into plain English for engineers.',
		'2026-01-10',
	),
]

describe('RSS compatibility', () => {
	it('is byte-identical to main: same entries, order, published dates and fallback', async () => {
		vi.stubEnv('COURSEBUILDER_URL', site)
		vi.stubEnv('DEPLOY_TIMESTAMP', '')
		vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
		fixture.execute
			.mockResolvedValueOnce({
				rows: [
					{
						workshop_id: 'w',
						workshop_type: 'workshop',
						workshop_slug: 'course',
						workshop_title: 'Course',
						workshop_description: 'Course description',
						workshop_state: 'published',
						workshop_visibility: 'public',
						workshop_publishedAt: '2026-01-01',
						workshop_updatedAt: '2026-10-12',
						item_type: 'lesson',
						lesson_slug: 'lesson',
						lesson_title: 'Lesson',
						lesson_description: 'Lesson description',
						lesson_state: 'published',
						lesson_visibility: 'public',
						lesson_publishedAt: '2026-01-02',
						lesson_updatedAt: '2026-10-13',
					},
				],
			})
			.mockResolvedValueOnce({
				rows: [
					{
						type: 'post',
						slug: 'post',
						title: 'Post',
						description: 'Post description',
						state: 'published',
						visibility: 'public',
						publishedAt: '2026-02-01',
						updatedAt: '2026-10-15',
					},
				],
			})
		const compiled = ts.transpileModule(baseline.generateRSS, {
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
		}).outputText
		const renderMain = new Function(
			'config',
			'env',
			'Feed',
			'sitemap',
			`${compiled}; return generateRSS`,
		)(config, env, Feed, async () => mainIndexFixture) as () => Promise<string>
		const expected = await renderMain()
		const response = await GET()
		expect(await response.text()).toBe(expected)
		expect(fixture.execute).toHaveBeenCalledTimes(2)
	})
})
