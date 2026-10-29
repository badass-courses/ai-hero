/**
 * The Slack approval route with `AI_HERO_BROADCAST_PROVIDER=drovr`, a fake
 * drovr client and Kit unreachable. Only a signed click by a configured
 * approver creates a drovr broadcast; the Kit approval is refused.
 */
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ client: null as any }))

vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/drovr-broadcasts', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/drovr-broadcasts')>()),
	drovrBroadcastClientFromEnv: () => mocks.client,
}))

import { POST } from './route'

const SECRET = 'slack-signing-secret'
const CHANNEL = 'C0211NSK3TP'

const plan = {
	campaignId: 'aihero-skills-changelog',
	campaignDisplayName: 'AI Hero Skills',
	layoutId: 'aihero-newsletter@drovr-1',
	perHour: 6000,
	hourly: 6000,
	daily: 60000,
	tickMs: 60000,
}

const drovrValue = {
	messageId: 'aihero.broadcast.x-1',
	version: 'v-abc',
	subject: 'Skills changelog',
	shortlink: 'https://aihero.dev/s/x',
}

const kitValue = {
	broadcastId: 123,
	subject: 'Skills changelog',
	description: 'AI Skills Changelog',
	content: '<p>Hi</p>',
	shortlink: 'https://aihero.dev/s/x',
}

// Slack's response_url is the only outbound call allowed; Kit is unreachable.
const outbound = vi.fn(
	async (input: RequestInfo | URL, _init?: RequestInit) => {
		if (String(input).startsWith('https://hooks.slack.test/')) {
			return new Response('ok')
		}
		throw new Error(`unreachable: ${String(input)}`)
	},
)

function signedRequest(actionId: string, value: unknown, userId: string) {
	const payload = {
		type: 'block_actions',
		user: { id: userId },
		channel: { id: CHANNEL },
		response_url: 'https://hooks.slack.test/response',
		actions: [{ action_id: actionId, value: JSON.stringify(value) }],
	}
	const body = new URLSearchParams({
		payload: JSON.stringify(payload),
	}).toString()
	const timestamp = String(Math.floor(Date.now() / 1000))
	const signature = `v0=${crypto
		.createHmac('sha256', SECRET)
		.update(`v0:${timestamp}:${body}`)
		.digest('hex')}`
	return new NextRequest(
		'https://aihero.test/api/slack/kit-broadcast-approval',
		{
			method: 'POST',
			body,
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'x-slack-request-timestamp': timestamp,
				'x-slack-signature': signature,
			},
		},
	)
}

function fakeClient() {
	return {
		newMessage: vi.fn(),
		validateMessageFile: vi.fn(),
		createBroadcast: vi.fn(async () => ({
			ok: true,
			value: {
				broadcastId: null,
				phase: 'capturing',
				captured: 0,
				sent: 0,
				nextMoves: [],
			},
		})),
		createShardedBroadcast: vi.fn(),
		broadcastStatus: vi.fn(),
		shardedBroadcastStatus: vi.fn(),
	}
}

const kitCalls = () =>
	outbound.mock.calls.filter(([input]) => String(input).includes('kit.com'))

beforeEach(() => {
	vi.stubGlobal('fetch', outbound)
	vi.stubEnv('SLACK_SIGNING_SECRET', SECRET)
	vi.stubEnv('CONVERTKIT_V4_API_KEY', 'kit-key-that-must-not-be-used')
	vi.stubEnv('AI_HERO_BROADCAST_PROVIDER', 'drovr')
	vi.stubEnv('AI_HERO_SKILLS_DROVR_SEND_PLAN', JSON.stringify(plan))
	vi.stubEnv('AI_HERO_BROADCAST_APPROVER_SLACK_IDS', 'U_APPROVER')
	mocks.client = fakeClient()
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	outbound.mockClear()
})

describe('drovr broadcast approval', () => {
	it("creates one drovr broadcast on an approver's click and reports it", async () => {
		const response = await POST(
			signedRequest(
				'ai_hero_skills_approve_drovr_send',
				drovrValue,
				'U_APPROVER',
			),
		)
		expect(await response.json()).toEqual({ ok: true })
		expect(mocks.client.createBroadcast).toHaveBeenCalledTimes(1)
		expect(mocks.client.createBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				draft: expect.objectContaining({
					broadcastId: 'aihero.broadcast.x-1@v-abc',
					messageId: 'aihero.broadcast.x-1',
					version: 'v-abc',
					tenantId: 'org-aihero',
				}),
				selector: { _tag: 'Tenant' },
				startAt: 'now',
			}),
		)
		const [, slackUpdate] = outbound.mock.calls.find(([input]) =>
			String(input).startsWith('https://hooks.slack.test/'),
		)!
		const update = JSON.parse(String(slackUpdate?.body))
		expect(update.text).toContain('Approved; drovr is sending')
		expect(update.text).toContain('aihero.broadcast.x-1@v-abc')
		expect(JSON.stringify(update.blocks)).not.toContain('Open in Kit')
		expect(kitCalls()).toEqual([])
	})

	it('never announces a send when drovr answers create_broadcast with junk', async () => {
		const actual = await vi.importActual<
			typeof import('@/lib/drovr-broadcasts')
		>('@/lib/drovr-broadcasts')
		mocks.client = actual.createDrovrBroadcastClient({
			config: { baseUrl: 'https://drovr.test', apiKey: 'tenant-key' },
			fetcher: vi.fn(
				async () => new Response('{"ok":true}', { status: 200 }),
			) as unknown as typeof fetch,
		})
		const response = await POST(
			signedRequest(
				'ai_hero_skills_approve_drovr_send',
				drovrValue,
				'U_APPROVER',
			),
		)
		const { text } = await response.json()
		expect(text).toContain('the send is unconfirmed')
		expect(text).not.toContain('drovr is sending')
		expect(
			outbound.mock.calls.some(([input]) =>
				String(input).startsWith('https://hooks.slack.test/'),
			),
		).toBe(false)
		expect(kitCalls()).toEqual([])
	})

	it('refuses a click from someone who is not an approver', async () => {
		const response = await POST(
			signedRequest(
				'ai_hero_skills_approve_drovr_send',
				drovrValue,
				'U_SOMEONE',
			),
		)
		expect((await response.json()).text).toContain('not an approver')
		expect(mocks.client.createBroadcast).not.toHaveBeenCalled()
		expect(kitCalls()).toEqual([])
	})

	it('refuses an unsigned click before anything runs', async () => {
		const request = signedRequest(
			'ai_hero_skills_approve_drovr_send',
			drovrValue,
			'U_APPROVER',
		)
		request.headers.set('x-slack-signature', 'v0=forged')
		const response = await POST(request)
		expect(response.status).toBe(401)
		expect(mocks.client.createBroadcast).not.toHaveBeenCalled()
	})

	it('refuses the Kit approval once drovr owns sending', async () => {
		const response = await POST(
			signedRequest('ai_hero_skills_approve_and_send', kitValue, 'U_APPROVER'),
		)
		expect((await response.json()).text).toContain('Kit sends are off')
		expect(kitCalls()).toEqual([])
		expect(mocks.client.createBroadcast).not.toHaveBeenCalled()
	})

	it('refuses the drovr approval while the provider is still Kit (dark)', async () => {
		vi.stubEnv('AI_HERO_BROADCAST_PROVIDER', '')
		const response = await POST(
			signedRequest(
				'ai_hero_skills_approve_drovr_send',
				drovrValue,
				'U_APPROVER',
			),
		)
		expect((await response.json()).text).toContain('drovr broadcasts are off')
		expect(mocks.client.createBroadcast).not.toHaveBeenCalled()
		expect(kitCalls()).toEqual([])
	})
})
