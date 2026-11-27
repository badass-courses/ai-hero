import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sendAnEmail: vi.fn(),
	getServerAuthSession: vi.fn(),
	findFirst: vi.fn(),
	limit: vi.fn(),
	cookieNames: [] as string[],
	warn: vi.fn(),
	error: vi.fn(),
}))

vi.mock('next/headers', () => ({
	cookies: async () => ({
		getAll: () => mocks.cookieNames.map((name) => ({ name, value: 'secret' })),
	}),
	headers: async () => new Headers({ 'x-real-ip': '1.2.3.4' }),
}))
vi.mock('@/db', () => ({
	db: { query: { users: { findFirst: mocks.findFirst } } },
}))
vi.mock('@/db/schema', () => ({ users: { id: 'id' } }))
vi.mock('@/emails/basic-email', () => ({ default: () => null }))
vi.mock('@/env.mjs', () => ({
	env: {
		NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test',
		NEXT_PUBLIC_SITE_TITLE: 'Site',
	},
}))
vi.mock('@/server/logger', () => ({
	log: { warn: mocks.warn, error: mocks.error },
}))
vi.mock('@/server/redis-client', () => ({ redis: {} }))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@coursebuilder/utils/send-an-email', () => ({
	sendAnEmail: mocks.sendAnEmail,
}))
vi.mock('@upstash/ratelimit', () => ({
	Ratelimit: class {
		static slidingWindow() {
			return {}
		}
		limit = mocks.limit
	},
}))

import { sendFeedbackFromUser } from './feedback-actions'
import {
	FEEDBACK_FAILURE_MESSAGE,
	FEEDBACK_SIGNED_OUT_MESSAGE,
} from './feedback-messages'

const row = { id: 'u1', email: 'row@example.test', name: 'Row Person' }
const input = { feedbackText: 'hello' }

beforeEach(() => {
	vi.clearAllMocks()
	mocks.cookieNames = []
	mocks.limit.mockResolvedValue({ success: true })
	mocks.findFirst.mockResolvedValue(row)
	mocks.sendAnEmail.mockResolvedValue(undefined)
	mocks.getServerAuthSession.mockResolvedValue({
		session: { user: { id: 'u1', email: 'row@example.test' } },
	})
})

describe('sendFeedbackFromUser', () => {
	it('sends to support with the row email as ReplyTo', async () => {
		expect(await sendFeedbackFromUser(input)).toEqual({ ok: true })
		const args = mocks.sendAnEmail.mock.calls[0]![0]
		expect(args.To).toBe('support@example.test')
		expect(args.ReplyTo).toBe('row@example.test')
	})

	it.each([
		['a different email', 'other@example.test'],
		['no email', undefined],
	])('still sends by user id when the session has %s', async (_n, email) => {
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'u1', email } },
		})
		expect(await sendFeedbackFromUser(input)).toEqual({ ok: true })
		expect(mocks.sendAnEmail.mock.calls[0]![0].ReplyTo).toBe('row@example.test')
	})

	it('refuses when signed out, and never uses a supplied email', async () => {
		mocks.getServerAuthSession.mockResolvedValue({ session: null })
		const result = await sendFeedbackFromUser({
			...input,
			emailAddress: 'spoof@example.test',
		} as any)
		expect(result).toEqual({
			ok: false,
			reason: 'no-session',
			message: FEEDBACK_SIGNED_OUT_MESSAGE,
		})
		expect(mocks.sendAnEmail).not.toHaveBeenCalled()
	})

	it.each([
		['authjs.session-token', true],
		['__Secure-authjs.session-token', true],
		['unrelated', false],
	])(
		'logs hadSessionCookie for a no-session refusal with %s',
		async (name, had) => {
			mocks.cookieNames = [name]
			mocks.getServerAuthSession.mockResolvedValue({ session: null })
			await sendFeedbackFromUser(input)
			expect(mocks.warn).toHaveBeenCalledWith('feedback.refused', {
				reason: 'no-session',
				userId: null,
				hadSessionCookie: had,
			})
			expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('secret')
		},
	)

	it('refuses when the id has no row', async () => {
		mocks.findFirst.mockResolvedValue(undefined)
		expect(await sendFeedbackFromUser(input)).toMatchObject({
			ok: false,
			reason: 'no-user',
		})
	})

	it('returns a plain message on send failure, logging no email or text', async () => {
		mocks.sendAnEmail.mockRejectedValue(new Error('smtp down'))
		expect(await sendFeedbackFromUser(input)).toEqual({
			ok: false,
			reason: 'send-failed',
			message: FEEDBACK_FAILURE_MESSAGE,
		})
		const logged = JSON.stringify([
			...mocks.warn.mock.calls,
			...mocks.error.mock.calls,
		])
		expect(logged).not.toContain('row@example.test')
		expect(logged).not.toContain('hello')
		expect(mocks.warn).toHaveBeenCalledWith('feedback.refused', {
			reason: 'send-failed',
			userId: 'u1',
		})
	})

	it('refuses the sixth send in the window', async () => {
		// Each send checks the user key and the IP key: 10 calls for 5 sends.
		let n = 0
		mocks.limit.mockImplementation(async () => ({ success: ++n <= 10 }))
		for (let i = 0; i < 5; i++) {
			expect(await sendFeedbackFromUser(input)).toEqual({ ok: true })
		}
		expect(await sendFeedbackFromUser(input)).toMatchObject({
			ok: false,
			reason: 'rate-limited',
		})
		expect(mocks.sendAnEmail).toHaveBeenCalledTimes(5)
	})
})
