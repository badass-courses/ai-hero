import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	serializeError: (error: unknown) => String(error),
}))
vi.mock('next/server', () => ({ after: vi.fn() }))

import { createExpiredDiscordTokenHandler } from './discord-session-refresh'
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
	const handle = createExpiredDiscordTokenHandler({
		refresh,
		bustUser,
		isDeferred,
		schedule,
		onError,
	})
	return { handle, refresh, bustUser, schedule, scheduled, onError, gate }
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

	it('still does not block when after() is unavailable', async () => {
		const h = handlerHarness(() => true)
		h.schedule.mockImplementationOnce(() => {
			throw new Error('after() outside request scope')
		})
		await h.handle('user-1')
		expect(h.refresh).toHaveBeenCalledOnce()
		expect(h.bustUser).not.toHaveBeenCalled()
		h.gate.resolve()
		await vi.waitFor(() => expect(h.bustUser).toHaveBeenCalledOnce())
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
		expect(h.onError).toHaveBeenCalledWith(expect.any(Error))
		expect(h.bustUser).toHaveBeenCalledWith('user-1')
	})
})
