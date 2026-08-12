import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPrompt: vi.fn(),
	getPromptProductIds: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	resolvePromptSubscriberContext: vi.fn(),
	sendGA4Event: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	after: vi.fn((callback: () => unknown) => callback()),
}))

vi.mock('next/server', async () => {
	const actual = await vi.importActual<typeof import('next/server')>('next/server')
	return { ...actual, after: mocks.after }
})
vi.mock('@/lib/agent-discovery', () => ({
	getDiscoveryBaseUrl: () => 'https://www.aihero.dev',
}))
vi.mock('@/lib/prompts-query', () => ({
	getPrompt: mocks.getPrompt,
	getPromptProductIds: mocks.getPromptProductIds,
}))
vi.mock('@/lib/prompt-subscriber-context', () => ({
	resolvePromptSubscriberContext: mocks.resolvePromptSubscriberContext,
}))
vi.mock('@/lib/ga4-measurement', () => ({
	extractGA4ClientId: () => '123.456',
	sendGA4Event: mocks.sendGA4Event,
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({ withSkill: (handler: unknown) => handler }))

import { GET } from '../route'

const prompt = {
	id: 'prompt_1',
	type: 'prompt',
	createdAt: new Date(),
	updatedAt: new Date(),
	deletedAt: null,
	createdById: 'user_1',
	fields: {
		title: 'Add the Uncle Bob livestream to my calendar',
		slug: 'add-uncle-bob-live-to-calendar',
		body: 'Add this livestream to my calendar.',
		description: 'A prompt for adding the livestream without duplicates.',
		state: 'published',
		visibility: 'unlisted',
		model: 'gpt-4o',
		provider: 'openai',
		event: {
			title: 'LIVE: Uncle Bob on Software Fundamentals in the Age of AI',
			description: 'Matt talks with Uncle Bob.',
			startsAt: '2026-08-19T15:00:00.000Z',
			endsAt: '2026-08-19T16:00:00.000Z',
			timezone: 'Europe/London',
			watchUrl: 'https://www.aihero.dev/s/uncle-bob-live',
			humanCalendarUrl: 'https://www.aihero.dev/s/uncle-bob-calendar',
			agentCalendarUrl: 'https://www.aihero.dev/s/uncle-bob-add-event',
		},
	},
}

const request = (query = '', accept = 'application/json') =>
	new NextRequest(
		`https://www.aihero.dev/api/prompts/add-uncle-bob-live-to-calendar${query}`,
		{ headers: { Accept: accept } },
	)

const context = {
	params: Promise.resolve({ slug: 'add-uncle-bob-live-to-calendar' }),
}

describe('agent prompt API', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getPrompt.mockResolvedValue(prompt)
		mocks.getPromptProductIds.mockResolvedValue(['product-ma254'])
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: null,
			authMethod: 'anonymous',
			ability: { can: vi.fn(() => false) },
		})
		mocks.resolvePromptSubscriberContext.mockResolvedValue({
			status: 'recognized',
			provider: 'kit',
			readAccess: 'published_prompt_and_event_only',
			identityAssurance: 'subscriber_id',
		})
		mocks.sendGA4Event.mockResolvedValue({ status: 'sent' })
	})

	it('returns published prompt context with bounded Kit reader access', async () => {
		const response = await GET(
			request('?ck_subscriber_id=4123456789&source=uncle-bob-prompt'),
			context,
		)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(body).toMatchObject({
			schema: 'aihero.agent-prompt.v1',
			productIds: ['product-ma254'],
			viewer: {
				authenticated: false,
				kitSubscriber: {
					status: 'recognized',
					readAccess: 'published_prompt_and_event_only',
				},
			},
			authorization: {
				lightweight: {
					grants: ['published_prompt:read', 'launch_event:read'],
				},
				full: { method: 'OAuth 2.0 device flow' },
			},
		})
		expect(body.authorization.full.command).toContain(
			'cb" auth login --app ai-hero',
		)
		expect(body).not.toHaveProperty('email')
		expect(mocks.resolvePromptSubscriberContext).toHaveBeenCalledWith({
			subscriberId: '4123456789',
			shKit: null,
		})
	})

	it('returns AGENT INSTRUCTIONS as Markdown when requested', async () => {
		const response = await GET(request('', 'text/markdown'), context)
		const body = await response.text()

		expect(response.headers.get('content-type')).toContain('text/markdown')
		expect(body).toContain('## AGENT INSTRUCTIONS')
		expect(body).toContain('## AUTHORIZATION')
		expect(body).toContain('auth login --app ai-hero')
	})

	it('does not expose a private prompt to an anonymous request', async () => {
		mocks.getPrompt.mockResolvedValue({
			...prompt,
			fields: { ...prompt.fields, visibility: 'private' },
		})

		const response = await GET(request(), context)
		expect(response.status).toBe(404)
	})
})
