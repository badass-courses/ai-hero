import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import { verifySupportSignature } from '@/lib/support-signature'
import {
	completeSupportPurchaseTransfer,
	inspectSupportPurchaseTransferCompletion,
} from '@/purchase-transfer/support-complete'
import {
	initiateSupportPurchaseTransfer,
	inspectSupportPurchaseTransfer,
} from '@/purchase-transfer/support-initiate'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { z } from 'zod'

/** Signed support purchase-transfer operator seam.
 * Invitations preserve the recipient-acceptance flow. support_complete uses
 * the same VERIFIED -> COMPLETED workflow after guarded buyer authorization.
 */
const requestSchema = z.object({
	mode: z.enum([
		'dry_run',
		'invite',
		'support_complete_dry_run',
		'support_complete',
		'support_complete_status',
	]),
	transferId: z.string().min(1).optional(),
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

	const { mode, transferId, purchaseId, sourceUserId, targetEmail, audit } =
		parsed.data
	const target = { purchaseId, sourceUserId, targetEmail }
	let result
	if (mode.startsWith('support_complete')) {
		if (!transferId) {
			return NextResponse.json(
				{ state: 'invalid', reason: 'transfer_id_required' },
				{ status: 400 },
			)
		}
		const completionTarget = { ...target, transferId }
		result =
			mode === 'support_complete'
				? await completeSupportPurchaseTransfer(completionTarget)
				: await inspectSupportPurchaseTransferCompletion(completionTarget)
	} else {
		result =
			mode === 'dry_run'
				? await inspectSupportPurchaseTransfer(target)
				: await initiateSupportPurchaseTransfer(target)
	}
	await log.info('purchase_transfer.support_result', {
		purchaseId,
		transferId: 'transferId' in result ? result.transferId : null,
		mode,
		state: result.state,
		...audit,
	})
	if (
		result.state === 'ready' ||
		result.state === 'invited' ||
		result.state === 'completion_requested' ||
		result.state === 'completed'
	) {
		return NextResponse.json({ state: result.state, transferId: result.transferId })
	}
	if (
		result.state === 'delivery_unknown' ||
		result.state === 'completion_pending'
	) {
		return NextResponse.json(
			{
				state: result.state,
				transferId: result.transferId,
				...('reason' in result ? { reason: result.reason } : {}),
			},
			{ status: 202 },
		)
	}
	return NextResponse.json(
		{ state: result.state, reason: result.reason },
		{ status: 409 },
	)
})
