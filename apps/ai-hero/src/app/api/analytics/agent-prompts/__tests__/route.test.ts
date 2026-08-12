import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getAgentPromptUsage: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	getServerAuthSession: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/analytics/providers/ga4', () => ({
	getAgentPromptUsage: mocks.getAgentPromptUsage,
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({ withSkill: (handler: unknown) => handler }))

import { GET } from '../route'

const request = (query = '') =>
	new NextRequest(
		`https://www.aihero.dev/api/analytics/agent-prompts${query}`,
	)

const analyticsAbility = {
	can: vi.fn(
		(action: string, subject: string) =>
			action === 'view' && subject === 'Analytics',
	),
}

describe('agent prompt analytics API', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: { can: vi.fn(() => false) },
		})
		mocks.getAgentPromptUsage.mockResolvedValue({
			slug: 'add-uncle-bob-live-to-calendar',
			range: '24h',
			events: { agent_prompt_copied: { eventCount: 3, users: 2 } },
			totals: { eventCount: 3 },
		})
	})

	it('returns aggregate prompt usage to an analytics reader', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { id: 'user_1' },
			ability: analyticsAbility,
		})

		const response = await GET(
			request('?slug=add-uncle-bob-live-to-calendar&range=24h'),
		)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(body).toMatchObject({
			ok: true,
			surface: 'agent-prompts',
			slug: 'add-uncle-bob-live-to-calendar',
			range: '24h',
			data: { totals: { eventCount: 3 } },
		})
	})

	it('rejects unauthenticated reads', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: null,
			ability: { can: vi.fn(() => false) },
		})

		const response = await GET(
			request('?slug=add-uncle-bob-live-to-calendar'),
		)
		expect(response.status).toBe(401)
		expect(mocks.getAgentPromptUsage).not.toHaveBeenCalled()
	})
})
