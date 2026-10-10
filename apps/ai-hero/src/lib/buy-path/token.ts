import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
const contextSchema = z
	.object({
		buyPathId: z.string().regex(/^cs_[a-zA-Z0-9_]+$/),
		productId: z.string().regex(/^[a-zA-Z0-9_-]{1,255}$/),
		userId: z
			.string()
			.regex(/^[a-zA-Z0-9_-]{1,255}$/)
			.nullable(),
		preSessionId: z
			.string()
			.regex(/^pre_[a-f0-9-]{36}$/)
			.nullable(),
		expiresAt: z.number(),
	})
	.strict()
export function signBuyPathToken(
	context: z.infer<typeof contextSchema>,
	secret: string,
) {
	const body = Buffer.from(
		JSON.stringify(contextSchema.parse(context)),
	).toString('base64url')
	return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
export function readBuyPathToken(token: string, secret: string) {
	try {
		const [body, signature, extra] = token.split('.')
		if (!body || !signature || extra || token.length > 2048) return null
		const expected = createHmac('sha256', secret).update(body).digest()
		const actual = Buffer.from(signature, 'base64url')
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
			return null
		const value = contextSchema.parse(
			JSON.parse(Buffer.from(body, 'base64url').toString()),
		)
		return value.expiresAt > Date.now() ? value : null
	} catch {
		return null
	}
}
