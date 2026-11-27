const base = '/api/commerce/coupon-batches'
export const couponBatchRoute = {
	submit: `POST ${base}`,
	preview: `POST ${base}/preview`,
	status: `GET ${base}/[batchId]`,
	lookup: `POST ${base}/lookup`,
	exportPage: `POST ${base}/export`,
} as const

// Error names can be mutated, and SQL/transport errors can carry secret values
// in their message, arguments and causes. Emit only an allowlisted class.
const classes = new Set([
	'Error',
	'TypeError',
	'RangeError',
	'ReferenceError',
	'SyntaxError',
	'AbortError',
	'TimeoutError',
	'DrizzleQueryError',
	'ZodError',
])

export async function logCouponBatchFailure(
	route: keyof typeof couponBatchRoute,
	phase: 'request' | 'wake',
	error: unknown,
) {
	try {
		const name = error instanceof Error ? error.name : ''
		const { log } = await import('@/server/logger')
		await log.error('coupon_batch.unexpected_failure', {
			route: couponBatchRoute[route],
			phase,
			errorClass: classes.has(name) ? name : 'UnknownError',
		})
	} catch {
		// A failure in the log sink must not mask the API response or block recovery.
	}
}
