import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getSkillEntries: vi.fn(),
	warn: vi.fn(),
}))

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/lib/skills-query', () => ({
	getSkillEntries: mocks.getSkillEntries,
}))
vi.mock('@/server/logger', () => ({
	log: { warn: mocks.warn, error: vi.fn(), info: vi.fn() },
}))

import type { SessionExtract } from './session-extract'
import { getSessionSkillLinks } from './session-skill-links'

const extract = (...skills: string[]): SessionExtract => ({
	sessions: [
		{
			sessionId: 's',
			entries: [
				{ kind: 'userPrompt', visibleFrom: 1, text: 'go' },
				...skills.map((skill, index) => ({
					kind: 'skillCall' as const,
					via: 'slashCommand' as const,
					visibleFrom: 2 + index,
					skill,
					args: null,
					skillBody: null,
				})),
			],
		},
	],
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getSkillEntries.mockResolvedValue([
		{ slug: 'skills-tdd', title: 'The /tdd Skill' },
		{ slug: 'skills-grill-me', title: 'The /grill-me Skill' },
	])
})

describe('getSessionSkillLinks', () => {
	it('links only the skills the session runs, as site paths', async () => {
		await expect(
			getSessionSkillLinks(extract('/tdd', 'unknown')),
		).resolves.toEqual({ tdd: '/skills-tdd' })
	})

	it('does not read the catalog for a session that runs no skill', async () => {
		await expect(getSessionSkillLinks(extract())).resolves.toEqual({})
		await expect(getSessionSkillLinks(null)).resolves.toEqual({})
		expect(mocks.getSkillEntries).not.toHaveBeenCalled()
	})

	it('leaves skills unlinked and logs when the catalog read fails', async () => {
		mocks.getSkillEntries.mockRejectedValue(new Error('down'))
		await expect(getSessionSkillLinks(extract('tdd'))).resolves.toEqual({})
		expect(mocks.warn).toHaveBeenCalledWith(
			'lesson.session_skill_links.failed',
			{ error: 'down' },
		)
	})
})
