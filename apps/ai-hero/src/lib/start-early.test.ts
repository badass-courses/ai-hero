import { afterEach, describe, expect, it, vi } from 'vitest'

import { startEarly } from './start-early'

const unhandled = vi.fn()

afterEach(() => {
	process.off('unhandledRejection', unhandled)
	unhandled.mockClear()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('startEarly', () => {
	it('starts the read immediately and resolves to its value', async () => {
		const read = vi.fn(async () => 'subscriber')

		const pending = startEarly(read)

		expect(read).toHaveBeenCalledOnce()
		await expect(pending).resolves.toBe('subscriber')
	})

	it('still rejects with the same error where it is awaited', async () => {
		const failure = new Error('kit down')

		const pending = startEarly(() => Promise.reject(failure))
		await settle()

		await expect(pending).rejects.toBe(failure)
	})

	it('does not raise an unhandled rejection when earlier work throws first', async () => {
		process.on('unhandledRejection', unhandled)

		startEarly(() => Promise.reject(new Error('never awaited')))
		await settle()
		await settle()

		expect(unhandled).not.toHaveBeenCalled()
	})

	it('runs reads started together concurrently, not one after another', async () => {
		const order: string[] = []
		const read = (name: string, ms: number) => () =>
			new Promise<string>((resolve) =>
				setTimeout(() => {
					order.push(name)
					resolve(name)
				}, ms),
			)

		const slow = startEarly(read('subscriber', 20))
		const fast = startEarly(read('product-map', 1))

		expect(await Promise.all([slow, fast])).toEqual([
			'subscriber',
			'product-map',
		])
		expect(order).toEqual(['product-map', 'subscriber'])
	})
})
