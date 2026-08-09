import { beforeEach, describe, expect, it, vi } from 'vitest'

const log = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}))

vi.mock('@/server/logger', () => ({ log }))

import { observeOAuthLinkCanary } from './oauth-link-observability'

const baseEvent = {
	flowId: 'olf_safe',
	provider: 'discord' as const,
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('OAuth link canary transport', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		log.info.mockResolvedValue(undefined)
		log.warn.mockResolvedValue(undefined)
		log.error.mockResolvedValue(undefined)
	})

	it('does not make non-critical lifecycle events wait for buffered ingest', async () => {
		const pending = deferred()
		log.info.mockReturnValueOnce(pending.promise)
		let settled = false

		void observeOAuthLinkCanary({
			...baseEvent,
			action: 'intent_issued',
		}).then(() => {
			settled = true
		})
		await Promise.resolve()

		expect(settled).toBe(true)
		expect(log.info).toHaveBeenCalledOnce()
		pending.resolve()
	})

	it('keeps critical invariant delivery awaited', async () => {
		const pending = deferred()
		log.error.mockReturnValueOnce(pending.promise)
		let settled = false

		const delivery = observeOAuthLinkCanary({
			...baseEvent,
			action: 'ownership_moved',
			critical: true,
		}).then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)

		pending.resolve()
		await delivery
		expect(settled).toBe(true)
	})
})
