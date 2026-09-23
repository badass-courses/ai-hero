import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import { verifySupportSignature } from '@/lib/support-signature'
import {
	initiateSupportPurchaseTransfer,
	inspectSupportPurchaseTransfer,
} from '@/purchase-transfer/support-initiate'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { z } from 'zod'

/** Signed support invitation. This does not transfer the purchase yet.
 * The named recipient must sign in and accept before the existing completion
 * workflow can mark ownership and access as verified.
 */
const requestSchema = z.object({
	mode: z.enum(['dry_run', 'invite']),
	purchaseId: z.string().min(1),
	sourceUserId: z.string().min(1),
	targetEmail: z.email(),
	audit: z.object({
		runId: z.string().min(1),
		conversationId: z.string().min(1),
		operatorId: z.string().min(1),
		approvalReference: z.string().min(1),
		expectedInboundId: z.string().min(1),
	}).strict(),
}).strict()

export const POST = withSkill(async (request: NextRequest) => {
	if (!env.SUPPORT_WEBHOOK_SECRET) {
		return NextResponse.json({ error: 'Support integration not configured' }, { status: 503 })
	}
	const bodyText = await request.text()
	const signature = verifySupportSignature({
		signatureHeader: request.headers.get('x-support-signature'),
		bodyText,
		webhookSecret: env.SUPPORT_WEBHOOK_SECRET,
	})
	if (!signature.valid)
		return NextResponse.json({ error: signature.error }, { status: 401 })
	let body: unknown
	try {
		body = JSON.parse(bodyText)
	} catch {
		return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
	}
	const parsed = requestSchema.safeParse(body)
	if (!parsed.success)
		return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

	const { mode, purchaseId, sourceUserId, targetEmail, audit } = parsed.data
	const target = { purchaseId, sourceUserId, targetEmail }
	const result = mode === 'dry_run'
		? await inspectSupportPurchaseTransfer(target)
		: await initiateSupportPurchaseTransfer(target)
	await log.info('purchase_transfer.support_invite_result', {
		purchaseId,
		mode,
		state: result.state,
		...audit,
	})
	if (result.state === 'ready' || result.state === 'invited') {
		return NextResponse.json({ state: result.state, transferId: result.transferId })
	}
	if (result.state === 'delivery_unknown') {
		return NextResponse.json({ state: result.state, transferId: result.transferId }, { status: 502 })
	}
	return NextResponse.json({ state: result.state, reason: result.reason }, { status: 409 })
})
