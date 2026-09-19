import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	inngestSend: vi.fn().mockResolvedValue(undefined),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	env: { KIT_WEBHOOK_SECRET: 's3cret', KIT_V4_API_KEY: 'kit-key' } as {
		KIT_WEBHOOK_SECRET?: string
		KIT_V4_API_KEY?: string
	},
}))

vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.inngestSend },
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { POST } from './route'

const kitReadback = (subscriber: Record<string, unknown> | null, ok = true) =>
	vi.fn().mockResolvedValue({
		ok,
		json: async () => ({ subscriber }),
	})

const post = (secret: string, body: unknown, event?: string) =>
	POST(
		new NextRequest(
			`http://localhost:3000/api/kit/webhook/${secret}${event ? `?event=${event}` : ''}`,
			{ method: 'POST', body: JSON.stringify(body) },
		),
		{ params: Promise.resolve({ secret }) },
	)

const kitBody = { subscriber: { id: 4290731338, email_address: 'x@y.z' } }

describe('POST /api/kit/webhook/[secret]', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.env.KIT_WEBHOOK_SECRET = 's3cret'
		mocks.env.KIT_V4_API_KEY = 'kit-key'
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('answers 404 to the wrong secret and reads nothing', async () => {
		const fetcher = kitReadback({
			id: 1,
			email_address: 'a@b.c',
			state: 'inactive',
		})
		vi.stubGlobal('fetch', fetcher)
		const response = await post('wrong', kitBody)
		expect(response.status).toBe(404)
		expect(fetcher).not.toHaveBeenCalled()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('ignores a subscriber Kit still reports as active (a forged or stale hook)', async () => {
		vi.stubGlobal(
			'fetch',
			kitReadback({ id: 4290731338, email_address: 'x@y.z', state: 'active' }),
		)
		const response = await post('s3cret', kitBody)
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toMatchObject({ status: 'ignored' })
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('captures an unsubscribe for every preference, from the read-back subscriber not the body', async () => {
		const fetcher = kitReadback({
			id: 4290731338,
			email_address: 'real@example.com',
			state: 'inactive',
		})
		vi.stubGlobal('fetch', fetcher)
		const response = await post(
			's3cret',
			{ subscriber: { id: 4290731338, email_address: 'spoofed@evil.example' } },
			'subscriber_complain',
		)
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toMatchObject({ status: 'captured' })
		expect(fetcher).toHaveBeenCalledWith(
			'https://api.kit.com/v4/subscribers/4290731338',
			{ headers: { 'X-Kit-Api-Key': 'kit-key' } },
		)
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
		const events = mocks.inngestSend.mock.calls[0]?.[0] as {
			name: string
			data: Record<string, unknown>
		}[]
		expect(events.map((event) => event.data.preferenceKey)).toEqual([
			'newsletter',
			'ai-skills',
		])
		for (const event of events) {
			expect(event.name).toBe('email-preferences/contact-unsubscribed')
			expect(event.data).toMatchObject({
				email: 'real@example.com',
				kitSubscriberId: '4290731338',
				source: 'kit-webhook:subscriber_complain',
			})
		}
	})

	it('fails closed with 503 when the subscriber cannot be verified', async () => {
		vi.stubGlobal('fetch', kitReadback(null, false))
		const response = await post('s3cret', kitBody)
		expect(response.status).toBe(503)
		expect(mocks.inngestSend).not.toHaveBeenCalled()
		expect(mocks.log.warn).toHaveBeenCalled()
	})

	it('rejects a body without a subscriber id', async () => {
		vi.stubGlobal('fetch', kitReadback(null))
		const response = await post('s3cret', {
			subscriber: { email_address: 'x@y.z' },
		})
		expect(response.status).toBe(400)
	})
})
