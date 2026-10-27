import { MySqlDialect } from 'drizzle-orm/mysql-core'
import type { SQL } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	cookies: new Map<string, string>(),
	findResponse: vi.fn(),
	findUser: vi.fn(),
	getSubscriber: vi.fn(),
	getSubscriberByEmail: vi.fn(),
	getSubscriberFromCookie: vi.fn(),
}))

vi.mock('next/headers', () => ({
	cookies: async () => ({
		get: (name: string) =>
			mocks.cookies.has(name)
				? { name, value: mocks.cookies.get(name)! }
				: undefined,
	}),
	headers: async () => new Headers(),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			questionResponse: { findFirst: mocks.findResponse },
			users: { findFirst: mocks.findUser },
		},
	},
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		getSubscriber: mocks.getSubscriber,
		getSubscriberByEmail: mocks.getSubscriberByEmail,
	},
}))
vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: mocks.getSubscriberFromCookie,
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { convertkitRouter } from './convertkit'

const dialect = new MySqlDialect()

function call(session: { user: { id?: string; email?: string } } | null) {
	return convertkitRouter
		.createCaller({
			db: null,
			session,
			ability: null,
			headers: new Headers(),
		} as any)
		.checkoutSurveyAnswer()
}

/** The identity the QuestionResponse lookup was scoped to. */
function queriedIdentity() {
	const where = mocks.findResponse.mock.calls[0]![0].where as SQL
	const { sql, params } = dialect.sqlToQuery(where)
	const column = sql.includes('`emailListSubscriberId` =')
		? 'emailListSubscriberId'
		: sql.includes('`userId` =')
			? 'userId'
			: null
	return { column, value: params.at(-1) }
}

describe('convertkit.checkoutSurveyAnswer identity', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.cookies.clear()
		mocks.findUser.mockResolvedValue(undefined)
		mocks.findResponse.mockResolvedValue({
			fields: { answer: 'matts_youtube' },
		})
	})

	afterEach(() => {
		// The whole point: no path through this query talks to Kit.
		expect(mocks.getSubscriber).not.toHaveBeenCalled()
		expect(mocks.getSubscriberByEmail).not.toHaveBeenCalled()
		expect(mocks.getSubscriberFromCookie).not.toHaveBeenCalled()
	})

	it('resolves the Kit id from the ck_subscriber_id value', async () => {
		mocks.cookies.set('ck_subscriber_id', '1234567')
		await expect(call(null)).resolves.toEqual({
			answered: true,
			answer: 'matts_youtube',
		})
		expect(queriedIdentity()).toEqual({
			column: 'emailListSubscriberId',
			value: '1234567',
		})
	})

	it('accepts the JSON-encoded id that setSubscriberCookie writes', async () => {
		mocks.cookies.set('ck_subscriber_id', '"1234567"')
		await call(null)
		expect(queriedIdentity()).toEqual({
			column: 'emailListSubscriberId',
			value: '1234567',
		})
	})

	it('prefers the session user over the Kit id, as before', async () => {
		mocks.cookies.set('ck_subscriber_id', '1234567')
		await call({ user: { id: 'user-1', email: 'viewer@example.test' } })
		expect(queriedIdentity()).toEqual({ column: 'userId', value: 'user-1' })
	})

	it('resolves a session email to its user without a Kit call', async () => {
		mocks.findUser.mockResolvedValue({ id: 'user-2' })
		await call({ user: { email: 'viewer@example.test' } })
		expect(queriedIdentity()).toEqual({ column: 'userId', value: 'user-2' })
	})

	it('falls back to the ck_subscriber cookie id when there is no id cookie', async () => {
		mocks.cookies.set(
			'ck_subscriber',
			JSON.stringify({
				id: 7654321,
				first_name: null,
				email_address: 'viewer@example.test',
				state: 'active',
				created_at: '2026-01-01T00:00:00Z',
				fields: {},
			}),
		)
		await call(null)
		expect(queriedIdentity()).toEqual({
			column: 'emailListSubscriberId',
			value: '7654321',
		})
	})

	it('treats a non-numeric id cookie as no identity, as a Kit 404 did', async () => {
		mocks.cookies.set('ck_subscriber_id', 'not-a-kit-id')
		await expect(call(null)).resolves.toEqual({
			answered: false,
			answer: null,
		})
		expect(mocks.findResponse).not.toHaveBeenCalled()
	})
})
