import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import {
	applySupportInvoicePrefill,
	describeInvoiceSettingsForLog,
	drizzleInvoiceSettingsDataSource,
} from '@/lib/invoice-settings'
import { verifySupportSignature } from '@/lib/support-signature'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { z } from 'zod'

/**
 * Guarded support seam for invoice prefill (AIH-259).
 *
 * Lets the support platform persist a customer's invoice details (company,
 * name, address, tax ID, notes) server-side and hand back a direct invoice
 * link. The signed body must name the exact purchase AND merchant charge,
 * carry the full audit block (run, conversation, operator, approval,
 * expected inbound message, input hash), and the server recomputes the
 * canonical settings hash before any write. The link is only returned after
 * the saved row is read back and matches the requested values. Every attempt
 * that reaches a resolved purchase leaves a redacted audit receipt. The link
 * and all logging carry identifiers only, never billing values.
 *
 * Authenticated with the same HMAC-SHA256 signature scheme as the main
 * support handler (`SUPPORT_WEBHOOK_SECRET`).
 */

const requestSchema = z.object({
	purchaseId: z.string().min(1),
	merchantChargeId: z.string().min(1),
	settings: z
		.object({
			recipientName: z.string().optional(),
			companyName: z.string().optional(),
			address: z.string().optional(),
			taxId: z.string().optional(),
			notes: z.string().optional(),
		})
		.strict(),
	audit: z
		.object({
			runId: z.string().min(1),
			conversationId: z.string().min(1),
			operatorId: z.string().min(1),
			approvalReference: z.string().min(1),
			expectedInboundId: z.string().min(1),
			inputHash: z.string().regex(/^[0-9a-f]{64}$/),
		})
		.strict(),
})

const REJECTION_STATUS: Record<string, number> = {
	not_found: 404,
	invalid: 422,
	input_hash_mismatch: 422,
	purchase_charge_mismatch: 409,
	// A readback mismatch is a server-side persistence failure, not a caller
	// error, so it must surface as a 5xx.
	readback_mismatch: 500,
}

export const POST = withSkill(async (request: NextRequest) => {
	if (!env.SUPPORT_WEBHOOK_SECRET) {
		return NextResponse.json(
			{ error: 'Support integration not configured' },
			{ status: 503 },
		)
	}

	const bodyText = await request.text()
	const signature = verifySupportSignature({
		signatureHeader: request.headers.get('x-support-signature'),
		bodyText,
		webhookSecret: env.SUPPORT_WEBHOOK_SECRET,
	})
	if (!signature.valid) {
		return NextResponse.json({ error: signature.error }, { status: 401 })
	}

	let body: unknown
	try {
		body = JSON.parse(bodyText)
	} catch {
		return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
	}

	const parsed = requestSchema.safeParse(body)
	if (!parsed.success) {
		return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
	}

	const { purchaseId, merchantChargeId, settings, audit } = parsed.data
	const auditForLog = {
		runId: audit.runId,
		conversationId: audit.conversationId,
		operatorId: audit.operatorId,
		approvalReference: audit.approvalReference,
	}
	const result = await applySupportInvoicePrefill(
		{ purchaseId, merchantChargeId, input: settings, audit },
		drizzleInvoiceSettingsDataSource,
	)

	if (result.state !== 'prefilled') {
		await log.warn('invoice-settings.support-prefill-rejected', {
			purchaseId,
			merchantChargeId,
			state: result.state,
			...auditForLog,
		})
		const status = REJECTION_STATUS[result.state] ?? 500
		return NextResponse.json(
			{ success: false, error: result.error },
			{ status },
		)
	}

	await log.info('invoice-settings.support-prefill', {
		...describeInvoiceSettingsForLog(result.settings),
		...auditForLog,
		receiptId: result.receipt.id,
	})

	const baseUrl = env.NEXT_PUBLIC_URL || 'https://www.aihero.dev'
	return NextResponse.json({
		success: true,
		invoiceUrl: `${baseUrl}${result.invoicePath}`,
		receiptId: result.receipt.id,
	})
})
