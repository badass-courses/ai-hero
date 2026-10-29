import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	batches: [] as unknown[],
	rows: [] as Array<{ lessonId: string; sessionExtract: unknown }>,
	warn: vi.fn(),
}))

vi.mock('@/db', () => {
	const chain = {
		from: () => chain,
		innerJoin: () => chain,
		where: (condition: unknown) => {
			mocks.batches.push(condition)
			return Promise.resolve(mocks.batches.length === 1 ? mocks.rows : [])
		},
	}
	return { db: { select: () => chain } }
})
vi.mock('@/server/logger', () => ({
	log: { warn: mocks.warn, error: vi.fn(), info: vi.fn() },
}))

import { getLessonSessionExtracts, skillLinksFrom } from './session-extracts'

const extract = (text: string) => ({
	sessions: [
		{
			sessionId: 's',
			entries: [{ kind: 'userPrompt', visibleFrom: 1, text }],
		},
	],
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.batches.length = 0
	mocks.rows = []
})

describe('getLessonSessionExtracts', () => {
	it('returns one extract per lesson, in the order asked, skipping lessons without one', async () => {
		mocks.rows = [
			{ lessonId: 'l2', sessionExtract: JSON.stringify(extract('second')) },
			{ lessonId: 'l1', sessionExtract: extract('first') },
			{ lessonId: 'l1', sessionExtract: extract('another video') },
			{ lessonId: 'l3', sessionExtract: null },
		]
		const result = await getLessonSessionExtracts(['l1', 'l2', 'l3', 'l1'])
		expect(
			result.map(({ lessonId, extract }) => [
				lessonId,
				extract.sessions[0]?.entries[0],
			]),
		).toEqual([
			['l1', { kind: 'userPrompt', visibleFrom: 1, text: 'first' }],
			['l2', { kind: 'userPrompt', visibleFrom: 1, text: 'second' }],
		])
	})

	it('leaves out a malformed extract and logs it, keeping the rest', async () => {
		mocks.rows = [
			{ lessonId: 'bad', sessionExtract: { sessions: 'nope' } },
			{ lessonId: 'good', sessionExtract: extract('ok') },
		]
		const result = await getLessonSessionExtracts(['bad', 'good'])
		expect(result.map((entry) => entry.lessonId)).toEqual(['good'])
		expect(mocks.warn).toHaveBeenCalledWith(
			'lesson.session_extract.invalid',
			expect.objectContaining({ lessonId: 'bad' }),
		)
	})

	it('queries in batches of 100 ids and not at all for none', async () => {
		await getLessonSessionExtracts([])
		expect(mocks.batches).toHaveLength(0)
		await getLessonSessionExtracts(
			Array.from({ length: 250 }, (_, index) => `l${index}`),
		)
		expect(mocks.batches).toHaveLength(3)
	})
})

describe('skillLinksFrom', () => {
	it('names each skill page by its nav label and its slug', () => {
		expect(
			skillLinksFrom(
				[
					{ slug: 'skills-grill-me', title: 'The /grill-me Skill' },
					{ slug: 'tdd', title: 'The /tdd Skill' },
				],
				'https://aihero.test',
			),
		).toEqual([
			{ skill: '/grill-me', url: 'https://aihero.test/skills-grill-me' },
			{ skill: 'grill-me', url: 'https://aihero.test/skills-grill-me' },
			{ skill: '/tdd', url: 'https://aihero.test/tdd' },
		])
	})
})
