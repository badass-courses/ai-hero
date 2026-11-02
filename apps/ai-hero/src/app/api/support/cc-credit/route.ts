import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { z } from 'zod'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { verifySupportSignature } from '@/lib/support-signature'
import { CreditRefusal } from '@/lib/cc-credit/domain'
import { readCreditBalance, runCreditCommand } from '@/lib/cc-credit/service'
import { readCreditInvoice } from '@/lib/cc-credit/stripe'
import {
	assertCreditWritesAllowed,
	c5StripeProducts,
	creditEnabled,
	creditImportEnabled,
	creditStore,
} from '@/lib/cc-credit/runtime'

export const dynamic = 'force-dynamic'
const scope = z
	.object({
		stripeCustomerId: z
			.string()
			.regex(/^cus_[A-Za-z0-9]+$/)
			.max(191)
			.optional(),
		organizationId: z.string().min(1).max(191).optional(),
	})
	.strict()
	.refine((row) => !!row.stripeCustomerId || !!row.organizationId)
const requestSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('balance'), scope }).strict(),
	z
		.object({
			mode: z.enum([
				'inspect',
				'reserve',
				'reconcile',
				'reconcile_preview',
				'backfill_preview',
				'backfill',
			]),
			scope,
			invoiceId: z
				.string()
				.regex(/^in_[A-Za-z0-9]+$/)
				.max(191),
			seats: z.number().int().min(1).max(100_000),
			audit: z
				.object({
					operatorId: z.string().min(1).max(191),
					runId: z.string().min(1).max(191),
					approvalReference: z.string().min(1).max(500),
				})
				.strict(),
			// Backfill only: one desk-reviewed source per credit line, in line order.
			sources: z
				.array(
					z
						.object({
							purchaseId: z.string().min(1).max(191),
							seats: z.number().int().min(1).max(100_000),
							perSeatCents: z.number().int().min(1).max(100_000_000),
						})
						.strict(),
				)
				.min(1)
				.max(50)
				.optional(),
		})
		.strict(),
])
const response = (body: unknown, status = 200) =>
	NextResponse.json(body, {
		status,
		headers: { 'Cache-Control': 'private, no-store' },
	})

/** Same timestamp/body HMAC as purchase-transfer. No Stripe mutations. */
export async function POST(request: NextRequest) {
	if (!env.SUPPORT_WEBHOOK_SECRET)
		return response({ error: 'Support integration not configured' }, 503)
	const bodyText = await request.text()
	const signature = verifySupportSignature({
		signatureHeader: request.headers.get('x-support-signature'),
		bodyText,
		webhookSecret: env.SUPPORT_WEBHOOK_SECRET,
	})
	if (!signature.valid) return response({ error: signature.error }, 401)
	let input: unknown
	try {
		input = JSON.parse(bodyText)
	} catch {
		return response({ error: 'Invalid JSON body' }, 400)
	}
	const parsed = requestSchema.safeParse(input)
	if (!parsed.success) return response({ error: 'Invalid request' }, 400)
	const body = parsed.data
	if (
		'sources' in body &&
		body.sources &&
		body.mode !== 'backfill' &&
		body.mode !== 'backfill_preview'
	)
		return response({ error: 'Invalid request' }, 400)
	if (body.mode === 'reserve' && !creditEnabled())
		return response(
			{ reason: 'credit_reservations_disabled_pending_backfill_review' },
			503,
		)
	if (body.mode === 'backfill' && !creditImportEnabled())
		return response({ reason: 'historical_credit_import_disabled' }, 503)
	try {
		const normalizedScope = {
			...body.scope,
			stripeCustomerId: body.scope.stripeCustomerId ?? '',
		}
		if (body.mode === 'balance')
			return response(await readCreditBalance(creditStore, normalizedScope))
		if (
			body.mode === 'reserve' ||
			body.mode === 'reconcile' ||
			body.mode === 'backfill'
		)
			assertCreditWritesAllowed(env.STRIPE_SECRET_TOKEN)
		const stripe = new Stripe(env.STRIPE_SECRET_TOKEN, {
			apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
		})
		const invoice = await readCreditInvoice(
			stripe,
			body.invoiceId,
			await c5StripeProducts(),
		)
		// Org-only callers use the authoritative invoice customer, never an email guess.
		const invoiceScope = {
			...normalizedScope,
			stripeCustomerId: body.scope.stripeCustomerId ?? invoice.stripeCustomerId,
		}
		const result = await runCreditCommand(creditStore, {
			...body,
			scope: invoiceScope,
			invoice,
		})
		await log
			.info('cc_credit.result', {
				mode: body.mode,
				invoiceId: body.invoiceId,
				state: result.state,
				...body.audit,
			})
			.catch(() => undefined)
		return response(result)
	} catch (error) {
		await log
			.warn('cc_credit.hold', {
				mode: body.mode,
				invoiceId: 'invoiceId' in body ? body.invoiceId : null,
				reason:
					error instanceof CreditRefusal
						? error.reason
						: 'evidence_or_ledger_unavailable',
			})
			.catch(() => undefined)
		if (error instanceof CreditRefusal)
			return response(
				{
					state: 'refused',
					reason: error.reason,
					...(error.remaining ? { remaining: error.remaining } : {}),
					next: 'Do not finalize or collect this credited invoice. Review the evidence with support.',
				},
				409,
			)
		// Missing schema, Stripe outage, lock timeout, deadlock or ambiguous commit:
		// none authorizes a credited invoice. Retry the SAME invoice id safely.
		return response(
			{
				state: 'hold',
				reason: 'credit_evidence_or_ledger_unavailable',
				next: 'Do not finalize. Retry the same invoice id or ask support to review.',
			},
			503,
		)
	}
}
