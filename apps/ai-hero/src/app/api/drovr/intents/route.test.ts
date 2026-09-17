import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	acceptDrovrIntent: vi.fn(),
	env: { DROVR_EXECUTOR_TOKEN: 'test-executor-token-1234567890' } as {
		DROVR_EXECUTOR_TOKEN?: string
	},
	log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/db/schema', () => ({ providerIdentity: {} }))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('@/lib/subscriber-marketing/drovr-executor', async () => {
	const actual = await vi.importActual<
		typeof import('@/lib/subscriber-marketing/drovr-executor')
	>('@/lib/subscriber-marketing/drovr-executor')
	return { ...actual, acceptDrovrIntent: mocks.acceptDrovrIntent }
})
vi.mock('@/server/logger', async () => {
	const actual =
		await vi.importActual<typeof import('@/server/logger')>('@/server/logger')
	return { ...actual, log: mocks.log }
})

import { POST } from './route'

const intent = {
	tenantId: 'org-aihero',
	contactId: 'contact-1',
	journeyId: 'value-path-skills-course',
	kind: 'email.send',
	idempotencyKey: 'intent:k',
	dueAt: '2026-09-16T22:30:00.000Z',
	payload: { emailResourceId: 'ai-hero-skills-workflow.email-0' },
}

const post = (body: unknown, token?: string) =>
	POST(
		new NextRequest('https://www.aihero.dev/api/drovr/intents', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}),
	)

describe('POST /api/drovr/intents', () => {
	beforeEach(() => {
		mocks.acceptDrovrIntent.mockReset()
		mocks.env.DROVR_EXECUTOR_TOKEN = 'test-executor-token-1234567890'
	})

	it('refuses without the executor bearer token as a problem detail', async () => {
		const response = await post(intent)
		expect(response.status).toBe(401)
		expect(response.headers.get('content-type')).toContain(
			'application/problem+json',
		)
		const body = await response.json()
		expect(body.type).toBe('urn:aihero:problem:unauthorized')
		expect(typeof body.hint).toBe('string')
		expect(mocks.acceptDrovrIntent).not.toHaveBeenCalled()
	})

	it('answers 503 when the token is not configured', async () => {
		mocks.env.DROVR_EXECUTOR_TOKEN = undefined
		const response = await post(intent, 'anything')
		expect(response.status).toBe(503)
	})

	it('accepts a well-formed intent with 202 and the executor result', async () => {
		mocks.acceptDrovrIntent.mockResolvedValue({
			status: 'accepted',
			intentId: 'sei-1',
			idempotencyKey: 'contact:contact-1:value-path:x:email:y',
			created: true,
		})
		const response = await post(intent, 'test-executor-token-1234567890')
		expect(response.status).toBe(202)
		expect(await response.json()).toMatchObject({
			status: 'accepted',
			intentId: 'sei-1',
			created: true,
		})
		expect(mocks.acceptDrovrIntent).toHaveBeenCalledWith(
			expect.objectContaining({ intent }),
		)
	})

	it('maps unsupported and missing-contact results to steering problems', async () => {
		mocks.acceptDrovrIntent.mockResolvedValueOnce({
			status: 'unsupported',
			reason: 'no executor',
			hint: 'do the other thing',
		})
		const unsupported = await post(intent, 'test-executor-token-1234567890')
		expect(unsupported.status).toBe(422)
		expect(await unsupported.json()).toMatchObject({
			type: 'urn:aihero:problem:unsupported-intent',
			hint: 'do the other thing',
		})

		mocks.acceptDrovrIntent.mockResolvedValueOnce({ status: 'contact-missing' })
		const missing = await post(intent, 'test-executor-token-1234567890')
		expect(missing.status).toBe(404)
	})

	it('rejects a malformed body with 400 before touching the executor', async () => {
		const response = await post(
			{ nope: true },
			'test-executor-token-1234567890',
		)
		expect(response.status).toBe(400)
		expect(mocks.acceptDrovrIntent).not.toHaveBeenCalled()
	})
})
