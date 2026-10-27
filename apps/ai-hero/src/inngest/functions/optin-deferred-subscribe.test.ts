import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: (...args: unknown[]) => args, send: vi.fn() },
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {},
	setKitSubscriberFields: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/ai-hero-email-opt-in.server', () => ({
	optInEmailHash: () => 'hash16',
	reconcileAiHeroEmailOptInWithKit: vi.fn(),
	routeReturningUnsubscriberWithKit: vi.fn(),
}))

import {
	OPTIN_DEFERRED_BACKOFF,
	runDeferredOptIn,
	type DeferredOptInDeps,
} from './optin-deferred-subscribe'

const data = {
	submissionKey: 'hash16:9376133:1',
	email: 'person@example.com',
	formId: 9376133,
	entry: 'form' as const,
	action: 'form-subscribe' as const,
	tenantId: 'org-aihero' as const,
	page: 'https://www.aihero.dev/',
	queuedAt: '2026-10-27T00:00:00.000Z',
}

/** Inngest memoizes a step by id; a replayed run must not redo it. */
function memoStep() {
	const memo = new Map<string, unknown>()
	const sleeps: string[] = []
	return {
		sleeps,
		step: {
			run: async <T>(id: string, fn: () => Promise<T>) => {
				if (!memo.has(id)) memo.set(id, await fn())
				return memo.get(id) as T
			},
			sleep: async (id: string) => {
				sleeps.push(id)
			},
		},
	}
}

function deps(verdicts: Array<'clear' | 'unknown' | 'stopped'>) {
	const queue = [...verdicts]
	const d = {
		readVerdict: vi.fn(async () => queue.shift() ?? 'unknown'),
		subscribe: vi.fn(async () => {}),
		afterSubscribe: vi.fn(async () => {}),
	} satisfies DeferredOptInDeps
	return d
}

const loggedEvents = () =>
	[mocks.log.info, mocks.log.warn, mocks.log.error].flatMap((fn) =>
		fn.mock.calls.map(([name]) => name),
	)

describe('runDeferredOptIn', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('drovr answers "no stop" on a later read: subscribes exactly once', async () => {
		const { step, sleeps } = memoStep()
		const d = deps(['unknown', 'unknown', 'clear'])
		await expect(runDeferredOptIn({ event: { data }, step }, d)).resolves.toEqual(
			{ status: 'subscribed' },
		)
		expect(d.readVerdict).toHaveBeenCalledTimes(3)
		expect(sleeps).toEqual(['backoff-0', 'backoff-1'])
		expect(d.subscribe).toHaveBeenCalledTimes(1)
		expect(d.afterSubscribe).toHaveBeenCalledTimes(1)
		expect(loggedEvents()).toContain('optin.deferred.subscribed')
	})

	it('a replayed run does not subscribe twice', async () => {
		const { step } = memoStep()
		const d = deps(['clear'])
		await runDeferredOptIn({ event: { data }, step }, d)
		await runDeferredOptIn({ event: { data }, step }, d)
		expect(d.subscribe).toHaveBeenCalledTimes(1)
		expect(d.readVerdict).toHaveBeenCalledTimes(1)
	})

	it('drovr says opted out: never subscribes', async () => {
		const { step } = memoStep()
		const d = deps(['unknown', 'stopped'])
		await expect(runDeferredOptIn({ event: { data }, step }, d)).resolves.toEqual(
			{ status: 'suppressed' },
		)
		expect(d.subscribe).not.toHaveBeenCalled()
		expect(d.afterSubscribe).not.toHaveBeenCalled()
		expect(loggedEvents()).toContain('optin.deferred.suppressed')
	})

	it('retries exhausted: gives up at error level and never subscribes', async () => {
		const { step, sleeps } = memoStep()
		const d = deps([])
		await expect(runDeferredOptIn({ event: { data }, step }, d)).resolves.toEqual(
			{ status: 'gave_up' },
		)
		expect(d.readVerdict).toHaveBeenCalledTimes(OPTIN_DEFERRED_BACKOFF.length + 1)
		expect(sleeps).toHaveLength(OPTIN_DEFERRED_BACKOFF.length)
		expect(d.subscribe).not.toHaveBeenCalled()
		expect(mocks.log.error).toHaveBeenCalledWith(
			'optin.deferred.gave_up',
			expect.objectContaining({ formId: 9376133, emailHash: 'hash16' }),
		)
	})

	it('backs off for about an hour', () => {
		const minutes = OPTIN_DEFERRED_BACKOFF.reduce((sum, wait) => {
			const n = Number.parseInt(wait)
			return sum + (wait.endsWith('s') ? n / 60 : n)
		}, 0)
		expect(minutes).toBeGreaterThan(45)
		expect(minutes).toBeLessThanOrEqual(60)
	})

	it('post-subscribe failure is logged, not retried into a second subscribe', async () => {
		const { step } = memoStep()
		const d = deps(['clear'])
		d.afterSubscribe.mockRejectedValue(new TypeError('boom'))
		await expect(runDeferredOptIn({ event: { data }, step }, d)).resolves.toEqual(
			{ status: 'subscribed' },
		)
		expect(d.subscribe).toHaveBeenCalledTimes(1)
		expect(mocks.log.error).toHaveBeenCalledWith(
			'optin.deferred.after_subscribe_failed',
			expect.objectContaining({ error: 'TypeError' }),
		)
	})

	it('never logs the address', async () => {
		const { step } = memoStep()
		await runDeferredOptIn({ event: { data }, step }, deps([]))
		await runDeferredOptIn({ event: { data }, step: memoStep().step }, deps(['clear']))
		const all = JSON.stringify([
			mocks.log.info.mock.calls,
			mocks.log.warn.mock.calls,
			mocks.log.error.mock.calls,
		])
		expect(all).not.toContain('person@example.com')
	})
})
