import { expect, it } from 'vitest'
import { scrubCouponTelemetry } from './telemetry'

it('strips private API bodies and redacts C5 bearers from request, span and replay URLs', () => {
	const bearer = 'c5comp_' + 'a'.repeat(40)
	const original = {
		transaction: 'POST /api/commerce/coupon-batches/export',
		request: {
			url: '/api/commerce/coupon-batches/export',
			data: { secret: 'export payload' },
			headers: { authorization: 'synthetic pat' },
		},
		spans: [
			{
				name: 'POST /api/coursebuilder/redeem/coupon',
				data: { 'http.request.body': 'synthetic free claim' },
			},
		],
		breadcrumbs: [{ url: `https://example.test/cohorts/c5?code=${bearer}` }],
	}
	const scrubbed = scrubCouponTelemetry(original)
	expect(JSON.stringify(scrubbed)).not.toMatch(
		/export payload|synthetic pat|synthetic free claim|c5comp_/,
	)
	expect(scrubbed.transaction).toBe(original.transaction)
	expect(scrubbed.breadcrumbs[0]?.url).toContain('[c5-comp-selector]')
	expect(original.request.data.secret).toBe('export payload')
})
