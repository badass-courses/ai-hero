import { describe, expect, it, vi } from 'vitest'
import { Feed } from 'feed'
import ts from 'typescript'
import baseline from '@/lib/__fixtures__/rss-main.json'

const fixture = vi.hoisted(() => {
	vi.stubEnv('NEXT_PUBLIC_URL', 'https://www.aihero.dev')
	return { execute: vi.fn() }
})
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
vi.mock('@/lib/skill-changelog-query', () => ({
	getSkillChangelogEntries: async () => [],
}))
import config from '@/config'
import { env } from '@/env.mjs'
import { GET } from './route'

const site = 'https://www.aihero.dev'
const fallbackBody = '**Engineering vocabulary** '.repeat(20).trim()
const frontmatterDescription =
	'**Detailed** [guide](https://example.test) ' +
	'vocabulary '.repeat(20).trim()
const mainDescription = new Function(
	`${ts.transpileModule(baseline.dictionaryDescription, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return getDescription`,
)() as (source: string) => string
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
	entry(
		'/ai-coding-dictionary/agent',
		'Agent | AI Coding Dictionary',
		mainDescription(fallbackBody),
		'2026-01-10',
	),
	entry(
		'/ai-coding-dictionary/model',
		'Model | AI Coding Dictionary',
		frontmatterDescription,
		'2026-01-10',
	),
]

describe('RSS compatibility', () => {
	it('is byte-identical to main: same entries, order, published dates and fallback', async () => {
		const sha = 'a'.repeat(40)
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = String(input)
				if (url.endsWith('/commits/main.atom'))
					return new Response(
						`<feed><entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><updated>2026-01-10T00:00:00Z</updated></entry></feed>`,
					)
				if (url.endsWith('/README.md'))
					return new Response(
						`## Section 1 — Foundations\n\n### Agent\n\n${fallbackBody}\n\n### Model\n\nModel fallback.`,
					)
				if (url.endsWith('/dictionary/Model.md'))
					return new Response(
						`---\ndescription: "${frontmatterDescription}"\n---\n\nBody`,
					)
				if (url.endsWith('/dictionary/Agent.md'))
					return new Response('unavailable', { status: 503 })
				throw new Error(`Unexpected fixture request: ${url}`)
			}),
		)
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
		const actual = await response.text()
		expect(actual).toBe(expected)
		expect(actual).toContain('**Detailed**')
		expect(mainDescription(fallbackBody)).toHaveLength(180)
		expect(fixture.execute).toHaveBeenCalledTimes(2)
	})
})
