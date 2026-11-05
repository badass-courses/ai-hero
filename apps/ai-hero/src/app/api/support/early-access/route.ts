import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env.mjs'
import { verifySupportSignature } from '@/lib/support-signature'
import {
	grantEarlyAccess,
	revokeEarlyAccess,
} from '@/lib/team-invoice/early-access'
import {
	earlyAccessPorts,
	reportEarlyAccess,
} from '@/lib/team-invoice/early-access-server'
import { log } from '@/server/logger'
import { z } from 'zod'

const inputSchema = z
	.object({
		command: z.enum(['grant', 'report', 'revoke']),
		invoiceId: z
			.string()
			.regex(/^in_[a-zA-Z0-9]+$/)
			.optional(),
		apply: z.boolean().default(false),
	})
	.strict()
	.refine((input) =>
		input.command === 'report'
			? !input.apply && !input.invoiceId
			: Boolean(input.invoiceId),
	)

export async function POST(request: NextRequest) {
	if (!env.SUPPORT_WEBHOOK_SECRET)
		return NextResponse.json(
			{ error: 'Support integration not configured' },
			{ status: 503 },
		)
	const bodyText = await request.text()
	const signature = verifySupportSignature({
		signatureHeader: request.headers.get('x-support-signature'),
		bodyText,
		webhookSecret: env.SUPPORT_WEBHOOK_SECRET,
	})
	if (!signature.valid)
		return NextResponse.json({ error: signature.error }, { status: 401 })
	let raw: unknown
	try {
		raw = JSON.parse(bodyText)
	} catch {
		return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
	}
	const parsed = inputSchema.safeParse(raw)
	if (!parsed.success)
		return NextResponse.json(
			{ error: 'Invalid early-access request' },
			{ status: 400 },
		)
	const { command, invoiceId, apply } = parsed.data
	try {
		const result =
			command === 'report'
				? await reportEarlyAccess()
				: command === 'grant'
					? await grantEarlyAccess(earlyAccessPorts, invoiceId!, apply)
					: await revokeEarlyAccess(earlyAccessPorts, invoiceId!, apply)
		await log.info('invoice.early_access.operator_result', {
			command,
			invoiceId,
			apply,
			state: result.state,
		})
		return NextResponse.json(result)
	} catch (error) {
		const message = error instanceof Error ? error.message : ''
		const safe =
			/^(DOUBLE:|Invoice in_|Invoice already|Invoice changed|Grant metadata|Grant purchase|No unambiguous|Invoice is paid|Purchase status|Another early-access|Subscription or|Exactly one positive|Invoice has no customer)/.test(
				message,
			)
		await log.error('invoice.early_access.operator_failed', {
			command,
			invoiceId,
			apply,
			double: message.startsWith('DOUBLE:'),
		})
		return NextResponse.json(
			{
				state: message.startsWith('DOUBLE:') ? 'DOUBLE' : 'refused',
				error: safe
					? message
					: 'Early-access operation failed. Check invoice and purchase readback; do not restore automatic provisioning.',
			},
			{ status: 409 },
		)
	}
}
