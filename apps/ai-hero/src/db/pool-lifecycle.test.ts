import { describe, expect, it, vi } from 'vitest'

import { createDatabasePoolCloser } from './pool-lifecycle'

describe('database pool lifecycle', () => {
	it('awaits the owned pool close once', async () => {
		let release: (() => void) | undefined
		const end = vi.fn(
			() => new Promise<void>((resolve) => {
				release = resolve
			}),
		)
		const close = createDatabasePoolCloser({ end })

		let settled = false
		const first = close().then(() => {
			settled = true
		})
		const second = close()

		expect(end).toHaveBeenCalledOnce()
		expect(settled).toBe(false)
		release?.()
		await expect(Promise.all([first, second])).resolves.toEqual([
			undefined,
			undefined,
		])
		expect(settled).toBe(true)
		expect(end).toHaveBeenCalledOnce()
	})
})
