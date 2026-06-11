import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	captureContentProgress,
	ContentProgressEventSchema,
	normalizeKitSubscriberId,
} from './content-progress'

const mocks = vi.hoisted(() => {
	const cookieValues = new Map<string, string>()
	const setCookie = vi.fn((name: string, value: string) =>
		cookieValues.set(name, value),
	)
	const headerValues = new Map<string, string | null>([
		['user-agent', 'Mozilla/5.0'],
		['referer', 'https://example.com/email'],
		['x-vercel-ip-country', 'US'],
	])
	const findContent = vi.fn()
	const findShortlink = vi.fn()
	const insertValues = vi.fn()
	return {
		cookieValues,
		setCookie,
		headerValues,
		findContent,
		findShortlink,
		insertValues,
	}
})

vi.mock('next/headers', () => ({
	cookies: vi.fn(async () => ({
		get: (name: string) => {
			const value = mocks.cookieValues.get(name)
			return value ? { value } : undefined
		},
		set: mocks.setCookie,
	})),
	headers: vi.fn(async () => ({
		get: (name: string) => mocks.headerValues.get(name.toLowerCase()) ?? null,
	})),
}))

vi.mock('@/db', () => ({
	db: {
		query: {
			contentResource: { findFirst: mocks.findContent },
			shortlink: { findFirst: mocks.findShortlink },
		},
		insert: () => ({ values: mocks.insertValues }),
	},
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(async () => ({
		session: { user: { id: 'user_123', email: 'test@example.com' } },
	})),
}))

vi.mock('@coursebuilder/utils/guid', () => ({ guid: () => 'guid_123' }))

const validPayload = {
	schemaVersion: 1,
	event: 'content.read',
	contentId: 'post_123',
	contentType: 'post',
	contentSlug: 'agentic-workflows',
	readSignal: 'dwell_30s',
	occurredAt: '2026-05-11T18:00:00.000Z',
	clientEventId: 'event_123',
	pathname: '/agentic-workflows',
}

describe('normalizeKitSubscriberId', () => {
	it('normalizes raw, JSON-stringified, numeric, and empty Kit subscriber IDs', () => {
		expect(normalizeKitSubscriberId('123456')).toBe('123456')
		expect(normalizeKitSubscriberId('"123456"')).toBe('123456')
		expect(normalizeKitSubscriberId('4108731318')).toBe('4108731318')
		expect(normalizeKitSubscriberId('')).toBeNull()
		expect(normalizeKitSubscriberId('   ')).toBeNull()
	})
})

describe('ContentProgressEventSchema', () => {
	it('accepts content read signals but not page loads', () => {
		expect(ContentProgressEventSchema.parse(validPayload)).toMatchObject({
			event: 'content.read',
			readSignal: 'dwell_30s',
		})
		expect(
			ContentProgressEventSchema.parse({
				...validPayload,
				contentId: 'ai-coding-dictionary',
				contentType: 'dictionary',
				contentSlug: 'ai-coding-dictionary',
			}),
		).toMatchObject({ contentType: 'dictionary' })

		expect(() =>
			ContentProgressEventSchema.parse({
				...validPayload,
				readSignal: 'page_load',
			}),
		).toThrow()
	})
})

describe('captureContentProgress', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.cookieValues.clear()
		mocks.headerValues.set('user-agent', 'Mozilla/5.0')
		mocks.headerValues.set('referer', 'https://example.com/email')
		mocks.headerValues.set('x-vercel-ip-country', 'US')
		mocks.findContent.mockResolvedValue({
			id: 'post_123',
			type: 'post',
			fields: { slug: 'agentic-workflows', title: 'Agentic Workflows' },
		})
		mocks.findShortlink.mockResolvedValue({
			slug: 'cc004-warmup-01',
			metadata: { schemaVersion: 1, campaign: 'cohort_004' },
		})
	})

	it('stages a content read with session, Kit, and shortlink evidence', async () => {
		mocks.cookieValues.set('sl_ref', 'cc004-warmup-01')
		mocks.cookieValues.set(
			'ft_attr',
			JSON.stringify({
				utm_source: 'kit',
				captured_at: '2026-05-11T00:00:00.000Z',
			}),
		)

		const result = await captureContentProgress({
			...validPayload,
			kit: {
				kitSubscriberId: '123456',
				emailSha256:
					'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			},
		})

		expect(result.status).toBe('captured')
		expect(mocks.setCookie).toHaveBeenCalledWith(
			'aih_session',
			expect.stringMatching(/^aih_/),
			expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
		)
		expect(mocks.setCookie).toHaveBeenCalledWith(
			'ck_subscriber_id',
			'123456',
			expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
		)
		expect(mocks.setCookie).toHaveBeenCalledWith(
			'ck_email_sha256',
			'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
		)
		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				contentId: 'post_123',
				contentType: 'post',
				readSignal: 'dwell_30s',
				sourceShortlinkSlug: 'cc004-warmup-01',
				shortlinkMetadata: { schemaVersion: 1, campaign: 'cohort_004' },
				firstTouch: expect.objectContaining({ utm_source: 'kit' }),
				userId: 'user_123',
				kitSubscriberId: '123456',
				emailSha256:
					'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			}),
		)
	})

	it('normalizes a quoted Kit subscriber cookie before staging a content read', async () => {
		mocks.cookieValues.set('ck_subscriber_id', '"123456"')

		await captureContentProgress(validPayload)

		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				kitSubscriberId: '123456',
			}),
		)
	})

	it('ignores bot-like user agents', async () => {
		mocks.headerValues.set('user-agent', 'Googlebot/2.1')

		const result = await captureContentProgress(validPayload)

		expect(result).toEqual({ status: 'ignored', reason: 'bot-like-user-agent' })
		expect(mocks.insertValues).not.toHaveBeenCalled()
	})
})
