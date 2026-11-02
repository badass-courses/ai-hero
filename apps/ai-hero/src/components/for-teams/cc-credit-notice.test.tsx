// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock('next-auth/react', () => ({
	useSession: () => ({
		status: auth.userId ? 'authenticated' : 'unauthenticated',
		data: auth.userId ? { user: { id: auth.userId } } : null,
	}),
}))
import { CcCreditNotice } from './cc-credit-notice'
let element: HTMLDivElement
let root: Root
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	auth.userId = null
	element = document.createElement('div')
	document.body.append(element)
	root = createRoot(element)
})
afterEach(async () => {
	await act(() => root.unmount())
	element.remove()
	vi.unstubAllGlobals()
})
const render = async () => {
	await act(async () => {
		root.render(<CcCreditNotice />)
	})
}
describe('private team credit island', () => {
	it('does not fetch or show an offer signed out', async () => {
		const fetcher = vi.fn()
		vi.stubGlobal('fetch', fetcher)
		await render()
		expect(fetcher).not.toHaveBeenCalled()
		expect(element.textContent).toBe('')
	})
	it('shows the total ledger balance in the reviewed product-name copy, without changing checkout', async () => {
		auth.userId = 'user_synthetic'
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ seats: 2, amountCents: 50000, currency: 'usd' }),
				),
		)
		vi.stubGlobal('fetch', fetcher)
		await render()
		expect(element.textContent).toContain(
			"Your team has 2 unused Crash Course seats. They're worth $500.00 off the same number of Software Factories for Real Engineers seats.",
		)
		expect(element.textContent).not.toContain('Cohort 5')
		expect(element.textContent).not.toContain('—')
		expect(element.querySelector('a')?.getAttribute('href')).toBe(
			'mailto:team@aihero.dev',
		)
		expect(element.querySelector('form')).toBeNull()
		expect(fetcher).toHaveBeenCalledWith(
			'/api/cc-credit/balance',
			expect.objectContaining({
				cache: 'no-store',
				credentials: 'same-origin',
			}),
		)
		auth.userId = null
		await render()
		expect(element.textContent).toBe('')
	})
	it('discards balances across user switches and sign-out, even when returning to the same user', async () => {
		const pending: ((response: Response) => void)[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
		)
		const answer = async (index: number, seats: number) =>
			act(async () =>
				pending[index]!(
					new Response(
						JSON.stringify({
							seats,
							amountCents: seats * 10000,
							currency: 'usd',
						}),
					),
				),
			)
		auth.userId = 'user_A'
		await render()
		await answer(0, 2)
		expect(element.textContent).toContain('2 unused')
		auth.userId = 'user_B'
		await render()
		expect(element.textContent).toBe('')
		auth.userId = 'user_A'
		await render()
		expect(element.textContent).toBe('')
		await answer(1, 9) // Late response for B cannot populate A.
		expect(element.textContent).toBe('')
		await answer(2, 1)
		expect(element.textContent).toContain('1 unused')
		auth.userId = null
		await render()
		auth.userId = 'user_A'
		await render()
		expect(element.textContent).toBe('')
		await answer(3, 3)
		expect(element.textContent).toContain('3 unused')
	})
	it.each([
		{ seats: 0, amountCents: 0, currency: 'usd' },
		{ seats: 1, amountCents: 100, currency: 'eur' },
	])('does not show zero/unsupported balances', async (balance) => {
		auth.userId = 'user_synthetic'
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(balance))),
		)
		await render()
		expect(element.textContent).toBe('')
	})
})
