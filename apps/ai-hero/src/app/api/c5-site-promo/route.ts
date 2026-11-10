import { c5PricingClosed } from '@/lib/c5-pricing/switch-server'

// Static pages need a fresh, read-only switch check after hydration.
export const dynamic = 'force-dynamic'

export async function GET() {
	return Response.json(
		{ pricingClosed: await c5PricingClosed() },
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}
