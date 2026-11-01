/**
 * AI Hero's broadcast producers with `AI_HERO_BROADCAST_PROVIDER=drovr`, a
 * fake drovr client and Kit unreachable: the changelog producer prepares a
 * drovr message and never calls Kit, and the Resend broadcast path neither
 * reads Kit consent nor sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createFunction: vi.fn((config, trigger, handler) => ({
		config,
		trigger,
		handler,
	})),
	getContentResource: vi.fn(),
	updateContentResourceFields: vi.fn(async () => undefined),
	findUser: vi.fn(),
	getProviderEmailPreferences: vi.fn(),
	syncLocalEmailPreferencesFromProvider: vi.fn(),
	resendSend: vi.fn(),
	client: null as any,
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getContentResource: mocks.getContentResource,
		updateContentResourceFields: mocks.updateContentResourceFields,
	},
	db: { query: { users: { findFirst: mocks.findUser } } },
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	serializeError: (error: unknown) => String(error),
}))
vi.mock('@/env.mjs', () => ({
	env: {
		NEXT_PUBLIC_URL: 'https://aihero.test',
		NEXT_PUBLIC_SITE_TITLE: 'AI Hero',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'team@aihero.test',
	},
}))
vi.mock('@/lib/email-preferences', () => ({
	getProviderEmailPreferences: mocks.getProviderEmailPreferences,
	syncLocalEmailPreferencesFromProvider:
		mocks.syncLocalEmailPreferencesFromProvider,
}))
vi.mock('@/emails/basic-email', () => ({ default: () => null }))
vi.mock('resend', () => ({
	Resend: class {
		emails = { send: mocks.resendSend }
	},
}))
vi.mock('@/lib/drovr-broadcasts', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/drovr-broadcasts')>()),
	drovrBroadcastClientFromEnv: () => mocks.client,
}))

import { emailSendBroadcast } from './email-send-broadcast'
import { skillChangelogBroadcast } from './skill-changelog-broadcast'

const step = {
	run: vi.fn(async (_name: string, fn: () => unknown) => await fn()),
}

const plan = {
	campaignId: 'aihero-skills-changelog',
	campaignDisplayName: 'AI Hero Skills',
	layoutId: 'aihero-newsletter@drovr-1',
	perHour: 6000,
	hourly: 6000,
	daily: 60000,
	tickMs: 60000,
}

const kitFetch = vi.fn(async (input: RequestInfo | URL) => {
	throw new Error(`Kit is unreachable: ${String(input)}`)
})

function fakeClient() {
	return {
		newMessage: vi.fn(async () => ({
			ok: true,
			value: { id: 'aihero.broadcast.skill-changelog-abc-1', path: 'x' },
		})),
		validateMessageFile: vi.fn(async (input: { path: string }) => ({
			ok: true,
			value: {
				messageId: 'aihero.broadcast.skill-changelog-abc-1',
				path: input.path,
				status: 'cataloged',
				reasons: [],
			},
		})),
		createBroadcast: vi.fn(),
		createShardedBroadcast: vi.fn(),
		broadcastStatus: vi.fn(),
		shardedBroadcastStatus: vi.fn(),
	}
}

const resource = {
	id: 'resource-1',
	type: 'post',
	fields: {
		postType: 'skill-changelog',
		state: 'published',
		title: 'Agents skill',
		slug: 'agents-skill',
		newsletterSubject: 'New: agents skill',
		newsletterPreviewText: 'What changed',
		newsletterCopy: 'Hello\n\nThe agents skill shipped.',
		kitBroadcastId: 123,
	},
}

const run = (fn: any, data: Record<string, unknown>) =>
	fn.handler({ event: { data }, step })

beforeEach(() => {
	vi.stubGlobal('fetch', kitFetch)
	vi.stubEnv('AI_HERO_BROADCAST_PROVIDER', 'drovr')
	vi.stubEnv('AI_HERO_SKILLS_DROVR_SEND_PLAN', JSON.stringify(plan))
	vi.stubEnv('CONVERTKIT_V4_API_KEY', 'kit-key-that-must-not-be-used')
	mocks.client = fakeClient()
	mocks.getContentResource.mockResolvedValue(resource)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.clearAllMocks()
})

describe('skill changelog producer through drovr', () => {
	it('prepares a drovr message and never calls Kit, even with a Kit draft on file', async () => {
		const result = await run(skillChangelogBroadcast, {
			resourceId: 'resource-1',
			slug: 'agents-skill',
		})

		expect(result).toMatchObject({
			status: 'drovr_prepared',
			drovrMessageId: 'aihero.broadcast.skill-changelog-abc-1',
			validation: 'cataloged',
		})
		expect(kitFetch).not.toHaveBeenCalled()
		expect(mocks.client.createBroadcast).not.toHaveBeenCalled()
		expect(mocks.client.createShardedBroadcast).not.toHaveBeenCalled()
		expect(mocks.client.validateMessageFile).toHaveBeenCalledWith({
			path: 'messages/aihero.broadcast.skill-changelog-abc-1.md',
			text: expect.stringContaining('subject: "New: agents skill"'),
		})
		expect(mocks.updateContentResourceFields).toHaveBeenCalledWith({
			id: 'resource-1',
			fields: expect.objectContaining({
				kitBroadcastId: 123,
				drovrMessageId: 'aihero.broadcast.skill-changelog-abc-1',
				drovrMessagePath: 'messages/aihero.broadcast.skill-changelog-abc-1.md',
				drovrMessageValidation: 'cataloged',
			}),
		})
	})

	it('skips, without Kit, when drovr is not configured', async () => {
		mocks.client = null
		const result = await run(skillChangelogBroadcast, {
			resourceId: 'resource-1',
			slug: 'agents-skill',
		})
		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'drovr_not_ready',
		})
		expect(kitFetch).not.toHaveBeenCalled()
		expect(mocks.updateContentResourceFields).not.toHaveBeenCalled()
	})

	it('sends nowhere when the provider is unknown', async () => {
		vi.stubEnv('AI_HERO_BROADCAST_PROVIDER', 'something-else')
		const result = await run(skillChangelogBroadcast, {
			resourceId: 'resource-1',
			slug: 'agents-skill',
		})
		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'provider_unknown',
		})
		expect(kitFetch).not.toHaveBeenCalled()
		expect(mocks.client.newMessage).not.toHaveBeenCalled()
	})

	it('still drafts in Kit when the provider is unset (dark)', async () => {
		vi.stubEnv('AI_HERO_BROADCAST_PROVIDER', '')
		await expect(
			run(skillChangelogBroadcast, {
				resourceId: 'resource-1',
				slug: 'agents-skill',
			}),
		).rejects.toThrow('Kit is unreachable')
		expect(kitFetch).toHaveBeenCalledWith(
			'https://api.kit.com/v4/broadcasts/123',
			expect.anything(),
		)
		expect(mocks.client.newMessage).not.toHaveBeenCalled()
	})
})

describe('Resend broadcast path through drovr', () => {
	it('neither reads Kit consent nor sends', async () => {
		const result = await run(emailSendBroadcast, { toUserId: 'u1' })
		expect(result).toBe('Broadcasts send through drovr')
		expect(mocks.findUser).not.toHaveBeenCalled()
		expect(mocks.getProviderEmailPreferences).not.toHaveBeenCalled()
		expect(mocks.resendSend).not.toHaveBeenCalled()
		expect(kitFetch).not.toHaveBeenCalled()
	})

	it('refuses an unknown provider without sending', async () => {
		vi.stubEnv('AI_HERO_BROADCAST_PROVIDER', 'something-else')
		await expect(run(emailSendBroadcast, { toUserId: 'u1' })).rejects.toThrow(
			'AI_HERO_BROADCAST_PROVIDER is unknown',
		)
		expect(mocks.getProviderEmailPreferences).not.toHaveBeenCalled()
		expect(mocks.resendSend).not.toHaveBeenCalled()
	})
})
