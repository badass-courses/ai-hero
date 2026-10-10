import { NextRequest } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { redis } from '@/server/redis-client'
import { env } from '@/env.mjs'
import { getServerAuthSession } from '@/server/auth'
import { courseBuilderAdapter } from '@/db'
import { ingestBuyPath } from '@/lib/buy-path/ingest'
import { readBuyPathToken } from '@/lib/buy-path/token'
import { purchaseBuyPathContext } from '@/lib/buy-path/read-context'
import { emitBuyPath } from '@/lib/buy-path/server'

const limiter = new Ratelimit({
	redis,
	prefix: 'buy-path-ingest',
	limiter: Ratelimit.slidingWindow(80, '1 m'),
})
// Development rig has no Redis. Production always uses the shared limiter, fail closed.
const developmentCounts = new Map<string, { count: number; until: number }>()
function developmentLimit(key: string) {
	const now = Date.now()
	for (const [k, v] of developmentCounts)
		if (v.until < now) developmentCounts.delete(k)
	if (developmentCounts.size >= 1000) return false
	const current = developmentCounts.get(key) ?? {
		count: 0,
		until: now + 60000,
	}
	current.count++
	developmentCounts.set(key, current)
	return current.count <= 80
}
export async function POST(request: NextRequest) {
	try {
		return await ingestBuyPath(request, {
			limit: async (key) =>
				env.NODE_ENV === 'development'
					? developmentLimit(key)
					: (await limiter.limit(key)).success,
			context: async (event) => {
				const { buyPathId } = event
				if (buyPathId.startsWith('pre_')) {
					if (
						!['pricing_viewed', 'redirect_to_stripe'].includes(event.step) ||
						request.cookies.get('buy_path_pre')?.value !== buyPathId ||
						!event.productId
					)
						return null
					const product = await courseBuilderAdapter.getProduct(event.productId)
					if (!product) return null
					const { session } = await getServerAuthSession()
					return {
						buyPathId,
						purchaseId: null,
						productId: product.id,
						userId: session?.user?.id ?? null,
					}
				}
				if (event.step === 'pricing_viewed' || !env.NEXTAUTH_SECRET) return null
				const context = readBuyPathToken(
					request.cookies.get('buy_path_session')?.value ?? '',
					env.NEXTAUTH_SECRET,
				)
				if (!context || context.buyPathId !== buyPathId) return null
				const purchase =
					await courseBuilderAdapter.getPurchaseByCheckoutSessionId(buyPathId)
				return purchase
					? await purchaseBuyPathContext(purchase.id)
					: { ...context, purchaseId: null }
			},
			emit: async (context, event) => {
				await emitBuyPath(context, event.step, {
					outcome: event.outcome,
					durationMs: event.durationMs,
					attempt: event.attempt,
					source: 'client',
				})
			},
		})
	} catch {
		return new Response(null, { status: 503 })
	}
}
