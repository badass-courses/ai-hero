import { describe, expect, it, vi } from 'vitest'

import {
	checkoutSessionIdFromUrl,
	createdCheckoutSessionId,
	expireOlderOpenSiblings,
	type CheckoutSessionReads,
} from './checkout-siblings'

const C5 = 'product-s00zs'
type Open = Awaited<ReturnType<CheckoutSessionReads['listOpen']>>[number]
const open = (id: string, created: number, over: Partial<Open> = {}): Open => ({
	id,
	created,
	status: 'open',
	metadata: { productId: C5, userId: 'user-1' },
	...over,
})

function reads(sessions: Open[], failOn: string[] = []) {
	const all = new Map(sessions.map((session) => [session.id, session]))
	const sessionReads: CheckoutSessionReads = {
		retrieve: async (id) => all.get(id)!,
		listOpen: async () => [...all.values()].filter((s) => s.status === 'open'),
		expire: vi.fn(async (id: string) => {
			if (failOn.includes(id)) throw new Error('already complete')
			all.set(id, { ...all.get(id)!, status: 'expired' })
		}),
	}
	return sessionReads
}

const run = (sessions: CheckoutSessionReads, keepSessionId: string) =>
	expireOlderOpenSiblings({
		sessions,
		customerIds: ['cus_1', 'cus_1'],
		userId: 'user-1',
		productId: C5,
		keepSessionId,
	})

describe('expireOlderOpenSiblings', () => {
	it('expires only the buyer\'s older open C5 sessions', async () => {
		const sessions = reads([
			open('cs_old', 100),
			open('cs_new', 200),
			open('cs_other_product', 50, {
				metadata: { productId: 'product-ma254', userId: 'user-1' },
			}),
			open('cs_other_user', 50, {
				metadata: { productId: C5, userId: 'user-2' },
			}),
		])
		await expect(run(sessions, 'cs_new')).resolves.toEqual({
			expired: ['cs_old'],
			failed: [],
		})
	})

	it('leaves exactly the newest open when two checkouts race', async () => {
		const sessions = reads([open('cs_a', 100), open('cs_b', 100)])
		// Both creators run their expiry; ties break on id.
		await Promise.all([run(sessions, 'cs_a'), run(sessions, 'cs_b')])
		const left = await sessions.listOpen('cus_1')
		expect(left.map((s) => s.id)).toEqual(['cs_b'])
	})

	it('reports a sibling that completed first instead of throwing', async () => {
		const sessions = reads([open('cs_paid', 100), open('cs_new', 200)], [
			'cs_paid',
		])
		await expect(run(sessions, 'cs_new')).resolves.toEqual({
			expired: [],
			failed: ['cs_paid'],
		})
	})
})

describe('created checkout session id', () => {
	it('reads a direct Stripe redirect and a verify-login one', () => {
		const stripe = 'https://checkout.stripe.com/c/pay/cs_test_abc123#frag'
		expect(checkoutSessionIdFromUrl(stripe)).toBe('cs_test_abc123')
		expect(
			createdCheckoutSessionId(
				new Response(null, { status: 303, headers: { location: stripe } }),
			),
		).toBe('cs_test_abc123')
		expect(
			createdCheckoutSessionId(
				new Response(null, {
					status: 303,
					headers: {
						location: `/subscribe/verify-login?checkoutUrl=${encodeURIComponent(stripe)}`,
					},
				}),
			),
		).toBe('cs_test_abc123')
	})

	it('ignores anything not hosted by Stripe', () => {
		expect(
			checkoutSessionIdFromUrl('https://evil.test/c/pay/cs_test_abc123'),
		).toBeNull()
		expect(createdCheckoutSessionId(new Response(null))).toBeNull()
	})
})
