import { describe, expect, it, vi } from 'vitest'

import { c5Closed, flagIsOn, type C5SwitchDeps } from './switch'

const deps = (over: Partial<C5SwitchDeps> = {}): C5SwitchDeps => ({
	envDisabled: () => false,
	readFlag: async () => 'true',
	flagDefault: false,
	timeoutMs: 50,
	...over,
})

describe('c5Closed', () => {
	it('closes C5 when the flag is off', async () => {
		expect(await c5Closed(deps({ readFlag: async () => false }))).toBe(true)
		expect(await c5Closed(deps({ readFlag: async () => 'false' }))).toBe(true)
	})

	it('opens C5 when the flag is on and the env override is unset', async () => {
		expect(await c5Closed(deps({ readFlag: async () => true }))).toBe(false)
		expect(await c5Closed(deps({ readFlag: async () => 'true' }))).toBe(false)
	})

	it.each([true, false])(
		'closes C5 on the env override whatever the flag says (flag %s)',
		async (flag) => {
			const readFlag = vi.fn(async () => flag)
			expect(
				await c5Closed(deps({ envDisabled: () => true, readFlag })),
			).toBe(true)
			expect(readFlag).not.toHaveBeenCalled()
		},
	)

	it('closes C5 when the flag read errors', async () => {
		const readFlag = async () => {
			throw new Error('redis unreachable')
		}
		expect(await c5Closed(deps({ readFlag }))).toBe(true)
	})

	it('closes C5 when the flag read outlasts the timeout', async () => {
		vi.useFakeTimers()
		try {
			const closed = c5Closed(
				deps({ readFlag: () => new Promise(() => {}), timeoutMs: 50 }),
			)
			await vi.advanceTimersByTimeAsync(50)
			expect(await closed).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it('uses the environment default only when the flag was never set', async () => {
		const unset = async () => null
		expect(await c5Closed(deps({ readFlag: unset, flagDefault: false }))).toBe(
			true,
		)
		expect(await c5Closed(deps({ readFlag: unset, flagDefault: true }))).toBe(
			false,
		)
		const failing = async () => {
			throw new Error('down')
		}
		expect(
			await c5Closed(deps({ readFlag: failing, flagDefault: true })),
		).toBe(true)
	})
})

describe('flagIsOn', () => {
	it('treats unrecognized stored values as off', () => {
		expect(flagIsOn('yes', true)).toBe(false)
		expect(flagIsOn('', true)).toBe(false)
		expect(flagIsOn({}, true)).toBe(false)
		expect(flagIsOn('1', false)).toBe(true)
	})
})
