import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
	db: { query: { accounts: { findFirst: vi.fn() } } },
}))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	serializeError: (error: unknown) => String(error),
}))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/server/session-access-runtime', () => ({
	bustSessionAccessForUser: vi.fn(async () => {}),
}))

import { db } from '@/db'
import { log } from '@/server/logger'
import { after } from 'next/server'

import {
	createExpiredDiscordTokenHandler,
	discordRefreshFailureFields,
	discordRefreshSkippedFields,
	handleExpiredDiscordToken,
} from './discord-session-refresh'
import {
	isInProxyAuthContext,
	runInProxyAuthContext,
} from './proxy-auth-context'

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function handlerHarness(isDeferred: () => boolean) {
	const gate = deferred()
	const refresh = vi.fn(() => gate.promise)
	const bustUser = vi.fn(async () => {})
	const scheduled: Array<() => Promise<void>> = []
	const schedule = vi.fn((task: () => Promise<void>) => {
		scheduled.push(task)
	})
	const onError = vi.fn()
	const onSkipped = vi.fn()
	const handle = createExpiredDiscordTokenHandler({
		refresh,
		bustUser,
		isDeferred,
		schedule,
		onError,
		onSkipped,
	})
	return { handle, refresh, bustUser, schedule, scheduled, onError, onSkipped, gate }
}

describe('proxy auth context', () => {
	it('is set only inside the proxy auth call', async () => {
		expect(isInProxyAuthContext()).toBe(false)
		await runInProxyAuthContext(async () => {
			await Promise.resolve()
			expect(isInProxyAuthContext()).toBe(true)
		})
		expect(isInProxyAuthContext()).toBe(false)
	})
})

describe('createExpiredDiscordTokenHandler', () => {
	it('never waits on the provider inside the proxy', async () => {
		const h = handlerHarness(() => true)
		await h.handle('user-1')
		expect(h.schedule).toHaveBeenCalledOnce()
		expect(h.refresh).not.toHaveBeenCalled()

		const task = h.scheduled[0]!()
		expect(h.refresh).toHaveBeenCalledWith('user-1')
		h.gate.resolve()
		await task
		expect(h.bustUser).toHaveBeenCalledWith('user-1')
	})

	it('skips the refresh in the proxy when after() is unavailable', async () => {
		const h = handlerHarness(() => true)
		h.schedule.mockImplementationOnce(() => {
			throw new Error('after() outside request scope')
		})
		await expect(h.handle('user-1')).resolves.toBeUndefined()
		await new Promise((done) => setTimeout(done, 0))
		expect(h.refresh).not.toHaveBeenCalled()
		expect(h.bustUser).not.toHaveBeenCalled()
		expect(h.onError).not.toHaveBeenCalled()
		expect(h.onSkipped).toHaveBeenCalledWith(expect.any(Error))

		// The next awaited page render still refreshes.
		const render = createExpiredDiscordTokenHandler({
			refresh: h.refresh,
			bustUser: h.bustUser,
			isDeferred: () => false,
			schedule: h.schedule,
			onError: h.onError,
			onSkipped: h.onSkipped,
		})
		const pending = render('user-1')
		h.gate.resolve()
		await pending
		expect(h.refresh).toHaveBeenCalledOnce()
		expect(h.bustUser).toHaveBeenCalledOnce()
	})

	it('awaits the refresh in page renders, as before', async () => {
		const h = handlerHarness(() => false)
		let settled = false
		const pending = h.handle('user-1').then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		h.gate.resolve()
		await pending
		expect(h.schedule).not.toHaveBeenCalled()
		expect(h.bustUser).toHaveBeenCalledWith('user-1')
	})

	it('runs one refresh per user at a time', async () => {
		const h = handlerHarness(() => false)
		const first = h.handle('user-1')
		const second = h.handle('user-1')
		h.gate.resolve()
		await Promise.all([first, second])
		expect(h.refresh).toHaveBeenCalledOnce()
	})

	it('logs failures instead of failing the session', async () => {
		const h = handlerHarness(() => false)
		h.refresh.mockRejectedValueOnce(new Error('db down'))
		await expect(h.handle('user-1')).resolves.toBeUndefined()
		expect(h.onError).toHaveBeenCalledWith(expect.any(Error), 'refresh')
		expect(h.bustUser).toHaveBeenCalledWith('user-1')
	})
})

describe('discord refresh failure logging', () => {
	const SENTINEL = 'FAKE-DISCORD-TOKEN-SENTINEL-6f1c'

	function leakyError() {
		const error = new Error(`refresh failed for token ${SENTINEL}`, {
			cause: new Error(`upstream said access_token=${SENTINEL}`),
		}) as Error & { status?: number; response?: unknown }
		error.status = 401
		error.response = { body: { refresh_token: SENTINEL } }
		return error
	}

	it('keeps only fixed fields', () => {
		expect(discordRefreshFailureFields(leakyError(), 'refresh')).toEqual({
			provider: 'discord',
			action: 'failed',
			stage: 'refresh',
			reasonCode: 'unexpected-error',
			errorName: 'Error',
			httpStatus: 401,
		})
		const named = new Error('x')
		named.name = `Bad ${SENTINEL}`
		expect(discordRefreshFailureFields(named, 'bust').errorName).toBe('Other')
		expect(discordRefreshSkippedFields(new Error(SENTINEL))).toEqual({
			provider: 'discord',
			action: 'skipped',
			stage: 'schedule',
			reasonCode: 'after-unavailable',
			errorName: 'Error',
		})
		expect(discordRefreshFailureFields(SENTINEL, 'bust')).toEqual({
			provider: 'discord',
			action: 'failed',
			stage: 'bust',
			reasonCode: 'unexpected-error',
			errorName: 'Other',
		})
	})

	it('logs only allowlisted error names', () => {
		const named = (name: string) => Object.assign(new Error('x'), { name })
		for (const name of ['TypeError', 'AbortError', 'TimeoutError', 'Error'])
			expect(discordRefreshFailureFields(named(name), 'refresh').errorName).toBe(
				name,
			)
		for (const name of ['DiscordApiError', 'Sentinel', SENTINEL, ''])
			expect(discordRefreshFailureFields(named(name), 'refresh').errorName).toBe(
				'Other',
			)
		expect(discordRefreshSkippedFields(named('MysteryError')).errorName).toBe(
			'Other',
		)
		expect(discordRefreshFailureFields({ name: 'TypeError' }, 'bust').errorName).toBe(
			'Other',
		)
	})

	it('emits no token text from the app handler', async () => {
		vi.mocked(after).mockImplementation(((task: () => Promise<void>) => {
			void task()
		}) as never)
		const { bustSessionAccessForUser } = await import(
			'@/server/session-access-runtime'
		)
		vi.mocked(bustSessionAccessForUser).mockRejectedValueOnce(leakyError())
		vi.mocked(db.query.accounts.findFirst).mockRejectedValueOnce(leakyError())

		await runInProxyAuthContext(() => handleExpiredDiscordToken('user-1'))
		await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(2))

		const logged = JSON.stringify([
			vi.mocked(log.info).mock.calls,
			vi.mocked(log.warn).mock.calls,
			vi.mocked(log.error).mock.calls,
		])
		expect(logged).not.toContain(SENTINEL)
		expect(vi.mocked(log.error).mock.calls.map(([, fields]) => fields)).toEqual([
			expect.objectContaining({ stage: 'refresh', errorName: 'Error' }),
			expect.objectContaining({ stage: 'bust', errorName: 'Error' }),
		])
	})

	it('logs a safe skip and starts no refresh when after() throws', async () => {
		vi.mocked(after).mockImplementation((() => {
			throw leakyError()
		}) as never)
		vi.mocked(db.query.accounts.findFirst).mockClear()
		vi.mocked(log.warn).mockClear()

		await runInProxyAuthContext(() => handleExpiredDiscordToken('user-2'))
		await new Promise((done) => setTimeout(done, 0))

		expect(db.query.accounts.findFirst).not.toHaveBeenCalled()
		expect(vi.mocked(log.warn).mock.calls).toEqual([
			['auth.discord.token-refresh', discordRefreshSkippedFields(new Error())],
		])
		expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(SENTINEL)
	})
})
