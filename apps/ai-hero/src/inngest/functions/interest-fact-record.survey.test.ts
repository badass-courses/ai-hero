import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn(
		(config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-emitter', () => ({
	drovrApiKeyForTenant: () => 'key',
}))
vi.mock('@/lib/subscriber-marketing/drovr-unsubscribe-page', () => ({
	resolveDrovrApiBaseUrl: () => 'https://drovr.test',
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

const { interestFactRecord } = await import('./interest-fact-record')
const handler = (interestFactRecord as any).handler as (ctx: unknown) => any

const data = {
	email: 'Human@example.test',
	fieldKey: 'survey_goal:response-1',
	expressedAt: '2026-10-28T17:20:00.000Z',
	via: 'survey' as const,
	survey: {
		rowId: 'response-1',
		questionId: 'aih_value_path_next_path_interest',
		answer: 'team_workflows',
	},
}
const step = {
	run: async (_id: string, fn: () => unknown) =>
		JSON.parse(JSON.stringify((await fn()) ?? null)),
	sleepUntil: vi.fn(),
}

/** Inngest retries a throwing step; model that as run-again-until-it-returns. */
async function withRetries(ctx: unknown, attempts = 5) {
	for (let i = 1; ; i++) {
		try {
			return await handler(ctx)
		} catch (error) {
			if (i >= attempts) throw error
		}
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})

describe('interest-fact-record survey goal facts', () => {
	it('retries a drovr 503 and records once', async () => {
		const recordBodies: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (String(url).endsWith('/resolve_contacts'))
					return Response.json({
						results: [{ index: 0, status: 'resolved', contactId: 'c-1' }],
					})
				recordBodies.push(String(init?.body))
				return recordBodies.length === 1
					? new Response('down', { status: 503 })
					: Response.json({ inserted: 1, duplicates: 0, conflicts: [] })
			}),
		)
		await expect(
			withRetries({ event: { data, ts: 1 }, step }),
		).resolves.toEqual({ survey: 'recorded' })
		expect(recordBodies).toHaveLength(2)
		expect(recordBodies[1]).toBe(recordBodies[0])
		expect(JSON.parse(recordBodies[1]!).facts[0].sourceId).toBe(
			JSON.stringify(['aihero', 'AI_QuestionResponse', 'response-1']),
		)
	})

	it('is keyed per answer row so a repeat send is one run', () => {
		expect((interestFactRecord as any).config.idempotency).toBe(
			'event.data.email + ":" + event.data.fieldKey',
		)
	})
})
