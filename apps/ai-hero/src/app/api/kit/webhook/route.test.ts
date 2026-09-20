import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	inngestSend: vi.fn().mockResolvedValue(undefined),
	dbSelect: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	env: { KIT_WEBHOOK_SECRET: 'whsec_test' } as { KIT_WEBHOOK_SECRET?: string },
}))

vi.mock('@/db', () => ({ db: { select: mocks.dbSelect } }))
vi.mock('@/env.mjs', () => ({ env: mocks.env }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.inngestSend },
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { POST, validKitSignature } from './route'

const SECRET = 'whsec_test'

const sign = (
	rawBody: string,
	secret = SECRET,
	t = Math.floor(Date.now() / 1000),
) =>
	`t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`

const post = (rawBody: string, signature: string | undefined) =>
	POST(
		new NextRequest('http://localhost:3000/api/kit/webhook', {
			method: 'POST',
			body: rawBody,
			headers: {
				'content-type': 'application/json',
				'x-kit-delivery': '123456',
				...(signature ? { 'x-kit-signature': signature } : {}),
			},
		}),
	)

const event = (
	type: string,
	subscriber: Record<string, unknown>,
	id = '9c2e1f3a-6b7d-4e8f-a1b2-c3d4e5f60718',
) => ({
	id,
	type,
	created: '2026-09-19T16:00:00Z',
	data: { subscriber },
})

const unsubscribed = event('subscriber.unsubscribed', {
	id: 4290731338,
	email_address: 'real@example.com',
	state: 'inactive',
})

describe('POST /api/kit/webhook', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.env.KIT_WEBHOOK_SECRET = SECRET
		mocks.dbSelect.mockReturnValue({
			from: () => ({
				where: () => ({
					limit: vi.fn().mockResolvedValue([{ contactId: 'contact-1' }]),
				}),
			}),
		})
	})

	it('rejects a delivery whose signature does not match and sends nothing', async () => {
		const raw = JSON.stringify({ delivery_id: 1, events: [unsubscribed] })
		const response = await post(raw, sign(raw, 'whsec_other'))
		expect(response.status).toBe(401)
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('rejects a missing signature', async () => {
		const raw = JSON.stringify({ delivery_id: 1, events: [unsubscribed] })
		const response = await post(raw, undefined)
		expect(response.status).toBe(401)
	})

	it('rejects a stale timestamp (replay) even with a valid HMAC', async () => {
		const raw = '{}'
		const old = Math.floor(Date.now() / 1000) - 3600
		expect(validKitSignature(raw, sign(raw, SECRET, old), SECRET)).toBe(false)
	})

	it('accepts any v1 entry during a secret rotation', async () => {
		const raw = '{"events":[]}'
		const t = Math.floor(Date.now() / 1000)
		const oldSig = createHmac('sha256', 'whsec_old')
			.update(`${t}.${raw}`)
			.digest('hex')
		const newSig = createHmac('sha256', SECRET)
			.update(`${t}.${raw}`)
			.digest('hex')
		expect(
			validKitSignature(raw, `t=${t},v1=${oldSig},v1=${newSig}`, SECRET),
		).toBe(true)
	})

	it('answers 503 when the secret is not configured so Kit retries later', async () => {
		mocks.env.KIT_WEBHOOK_SECRET = undefined
		const raw = JSON.stringify({ events: [unsubscribed] })
		const response = await post(raw, sign(raw))
		expect(response.status).toBe(503)
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'kit.webhook.unverifiable',
			expect.objectContaining({ reason: 'KIT_WEBHOOK_SECRET missing' }),
		)
	})

	it('captures an unsubscribe for every preference with a dedupe id per event', async () => {
		const raw = JSON.stringify({ delivery_id: 123456, events: [unsubscribed] })
		const response = await post(raw, sign(raw))
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ captured: 1, ignored: 0 })
		expect(mocks.inngestSend).toHaveBeenCalledTimes(2)
		const sent = mocks.inngestSend.mock.calls.flatMap(
			([batch]) =>
				batch as Array<{
					id: string
					name: string
					data: Record<string, unknown>
				}>,
		)
		const preferenceEvents = sent.filter(
			(e) => e.name === 'email-preferences/contact-unsubscribed',
		)
		expect(preferenceEvents.map((e) => e.data.preferenceKey)).toEqual([
			'newsletter',
			'ai-skills',
		])
		expect(preferenceEvents.map((e) => e.id)).toEqual([
			'kit-webhook:9c2e1f3a-6b7d-4e8f-a1b2-c3d4e5f60718:newsletter',
			'kit-webhook:9c2e1f3a-6b7d-4e8f-a1b2-c3d4e5f60718:ai-skills',
		])
		for (const e of preferenceEvents) {
			expect(e.data).toMatchObject({
				email: 'real@example.com',
				kitSubscriberId: '4290731338',
				source: 'kit-webhook:subscriber.unsubscribed',
				occurredAt: '2026-09-19T16:00:00Z',
			})
		}
		const directoryEvent = sent.find((e) => e.name === 'drovr/events.deliver')
		expect(directoryEvent).toMatchObject({
			id: 'kit-directory:9c2e1f3a-6b7d-4e8f-a1b2-c3d4e5f60718:contact.unsubscribed',
			data: {
				source: 'kit-webhook',
				events: [
					{
						tenantId: 'org-aihero',
						contactId: 'contact-1',
						journeyId: 'contact-directory',
						type: 'contact.unsubscribed',
						occurredAt: '2026-09-19T16:00:00Z',
						idempotencyKey:
							'directory:kit-state:4290731338:9c2e1f3a-6b7d-4e8f-a1b2-c3d4e5f60718:unsubscribed',
					},
				],
			},
		})
		expect(mocks.log.info).toHaveBeenCalledWith(
			'kit.webhook.captured',
			expect.objectContaining({
				deliveryId: '123456',
				kitSubscriberId: '4290731338',
			}),
		)
	})

	it('walks a batched delivery, skipping events that are not stopping events or still active', async () => {
		const raw = JSON.stringify({
			delivery_id: 7,
			events: [
				event(
					'subscriber.complained',
					{ id: 1, email_address: 'a@b.c', state: 'inactive' },
					'e1',
				),
				event(
					'subscriber.complained',
					{ id: 2, email_address: 'd@e.f', state: 'active' },
					'e2',
				),
				event(
					'subscriber.complained',
					{ id: 3, email_address: 'g@h.i', state: 'inactive' },
					'e3',
				),
			],
		})
		const response = await post(raw, sign(raw))
		await expect(response.json()).resolves.toEqual({ captured: 2, ignored: 1 })
		expect(mocks.inngestSend).toHaveBeenCalledTimes(4)
		expect(mocks.log.info).toHaveBeenCalledWith(
			'kit.webhook.ignored',
			expect.objectContaining({ eventIds: ['e2'] }),
		)
	})

	it('queues confirmed and bounced directory state without sending Kit preferences', async () => {
		const raw = JSON.stringify({
			events: [
				event('subscriber.confirmed', {
					id: 11,
					state: 'active',
				}),
				event('subscriber.bounced', {
					id: 12,
					state: 'inactive',
				}),
			],
		})
		const response = await post(raw, sign(raw))
		await expect(response.json()).resolves.toEqual({ captured: 2, ignored: 0 })
		expect(mocks.inngestSend).toHaveBeenCalledTimes(2)
		expect(
			mocks.inngestSend.mock.calls.map(
				([delivery]: [{ data: { events: Array<{ type: string }> } }]) =>
					delivery.data.events[0]?.type,
			),
		).toEqual(['contact.confirmed', 'contact.bounced'])
	})

	it('keeps confirmed directory events distinct by Kit event id', async () => {
		const raw = JSON.stringify({
			events: [
				event(
					'subscriber.confirmed',
					{ id: 11, state: 'active' },
					'confirmed-1',
				),
				event(
					'subscriber.confirmed',
					{ id: 11, state: 'active' },
					'confirmed-2',
				),
			],
		})
		const response = await post(raw, sign(raw))
		await expect(response.json()).resolves.toEqual({ captured: 2, ignored: 0 })

		const directoryEvents = mocks.inngestSend.mock.calls.map(
			([delivery]) =>
				(
					delivery as {
						data: { events: Array<{ idempotencyKey: string }> }
					}
				).data.events[0]?.idempotencyKey,
		)
		expect(directoryEvents).toEqual([
			'directory:kit-state:11:confirmed-1:confirmed',
			'directory:kit-state:11:confirmed-2:confirmed',
		])
	})

	it('drops directory state when the Kit identity is unknown', async () => {
		mocks.dbSelect.mockReturnValue({
			from: () => ({
				where: () => ({ limit: vi.fn().mockResolvedValue([]) }),
			}),
		})
		const raw = JSON.stringify({
			events: [
				event('subscriber.confirmed', {
					id: 99,
					state: 'active',
				}),
			],
		})
		const response = await post(raw, sign(raw))
		await expect(response.json()).resolves.toEqual({ captured: 0, ignored: 1 })
		expect(mocks.inngestSend).not.toHaveBeenCalled()
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'kit.webhook.directory_contact_missing',
			expect.objectContaining({ kitSubscriberId: '99' }),
		)
	})

	it('ignores a signed delivery of an unrelated event type', async () => {
		const raw = JSON.stringify({
			events: [
				event('subscriber.created', {
					id: 9,
					email_address: 'n@e.w',
					state: 'active',
				}),
			],
		})
		const response = await post(raw, sign(raw))
		await expect(response.json()).resolves.toEqual({ captured: 0, ignored: 1 })
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('answers 400 to a signed body without an events array', async () => {
		const raw = JSON.stringify({ subscriber: { id: 1 } })
		const response = await post(raw, sign(raw))
		expect(response.status).toBe(400)
	})
})
