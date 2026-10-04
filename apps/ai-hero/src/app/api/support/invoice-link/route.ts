import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import { mintSupportInvoiceLink } from '@/lib/invoice-links'
import { verifySupportSignature } from '@/lib/support-signature'
import { withSkill } from '@/server/with-skill'
import { z } from 'zod'

export const dynamic = 'force-dynamic'
const headers = {
	'Cache-Control': 'private, no-store',
	'Referrer-Policy': 'no-referrer',
}
const requestSchema = z
	.object({ merchantChargeId: z.string().min(1).max(255) })
	.strict()
const rejectionStatus = {
	denied: 403,
	not_found: 404,
	unavailable: 503,
} as const

/**
 * Read-only support mint endpoint. Same SUPPORT_WEBHOOK_SECRET, signed raw
 * body and five-minute authentication window as /api/support/invoice-prefill.
 * Never logs a minted link, cookie, billing values or invoice-link secret.
 */
export const POST = withSkill(async (request: NextRequest) => {
	if (!env.SUPPORT_WEBHOOK_SECRET) {
		return NextResponse.json(
			{ error: 'Support integration not configured' },
			{ status: 503, headers },
		)
	}
	const bodyText = await request.text()
	const signature = verifySupportSignature({
		signatureHeader: request.headers.get('x-support-signature'),
		bodyText,
		webhookSecret: env.SUPPORT_WEBHOOK_SECRET,
	})
	if (!signature.valid) {
		return NextResponse.json(
			{ error: signature.error },
			{ status: 401, headers },
		)
	}
	let body: unknown
	try {
		body = JSON.parse(bodyText)
	} catch {
		return NextResponse.json(
			{ error: 'Invalid JSON body' },
			{ status: 400, headers },
		)
	}
	const parsed = requestSchema.safeParse(body)
	if (!parsed.success) {
		return NextResponse.json(
			{ error: 'Invalid request' },
			{ status: 400, headers },
		)
	}
	const result = await mintSupportInvoiceLink(parsed.data)
	if (result.state !== 'minted') {
		return NextResponse.json(
			{ success: false, error: result.error },
			{ status: rejectionStatus[result.state], headers },
		)
	}
	return NextResponse.json(
		{
			success: true,
			invoiceUrl: `${env.NEXT_PUBLIC_URL || 'https://www.aihero.dev'}${result.invoicePath}`,
		},
		{ headers },
	)
})
