import { NextRequest, NextResponse } from 'next/server'
import { courseBuilderAdapter } from '@/db'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
	const sessionId = request.nextUrl.searchParams.get('session_id')
	if (!sessionId || !sessionId.startsWith('cs_')) {
		return NextResponse.json(
			{ status: 'error', message: 'Invalid session_id' },
			{ status: 400 },
		)
	}

	if (
		typeof courseBuilderAdapter.getPurchaseByCheckoutSessionId !== 'function'
	) {
		return NextResponse.json(
			{
				status: 'error',
				message: 'Checkout session purchase lookup is unavailable',
			},
			{ status: 500 },
		)
	}

	const purchase =
		await courseBuilderAdapter.getPurchaseByCheckoutSessionId(sessionId)

	if (purchase?.id) {
		return NextResponse.json({ status: 'ready', purchaseId: purchase.id })
	}

	// Keep this endpoint DB-only and cheap. The page only needs to know when the
	// webhook-created purchase row exists. If setup takes too long, the client
	// shows support copy instead of turning a stuck checkout into repeated Stripe
	// or merchant-event scans.
	return NextResponse.json({ status: 'processing' })
}
