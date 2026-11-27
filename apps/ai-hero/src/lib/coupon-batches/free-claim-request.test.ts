import { expect, it, vi } from 'vitest'
import { INTERNAL_COMP_CLAIM, withPrivateCompClaim } from './free-claim-request'

const path = 'https://example.test/api/coursebuilder/redeem/coupon'
const code = 'c5comp_' + 'a'.repeat(40)

it('does not dispatch an unsupported redeem body to Course Builder', async () => {
	const dispatch = vi.fn(async () => new Response(null))
	const body = new FormData()
	body.set('couponId', code)
	const response = await withPrivateCompClaim(
		new Request(path, { method: 'POST', body }),
		dispatch,
	)
	expect(response.status).toBe(415)
	expect(await response.text()).not.toContain(code)
	expect(dispatch).not.toHaveBeenCalled()
})

it('forwards a supported form only after replacing its bearer', async () => {
	const dispatch = vi.fn(async (request: Request) => {
		expect((await request.formData()).get('couponId')).toBe(INTERNAL_COMP_CLAIM)
		return new Response(null)
	})
	await withPrivateCompClaim(
		new Request(path, {
			method: 'POST',
			body: new URLSearchParams({ couponId: code }),
		}),
		dispatch,
	)
	expect(dispatch).toHaveBeenCalledOnce()
})
