/**
 * Desk workflow (no Stripe writes):
 *   pnpm exec tsx scripts/cc-credit.ts --url https://www.aihero.dev --request /private/request.json
 *   pnpm exec tsx scripts/cc-credit.ts --url https://www.aihero.dev --request /private/request.json --apply
 *
 * request.json: {"mode":"reserve","scope":{"stripeCustomerId":"cus_..."},
 * "invoiceId":"in_...","seats":2,"audit":{"operatorId":"...","runId":"...","approvalReference":"..."}}
 * Set SUPPORT_WEBHOOK_SECRET via secret injection, never argv or a Vercel env pull.
 * Default is inspect. --apply authorizes ONLY the app-ledger reservation/settlement.
 * On reserve success, use returned invoiceLines unchanged on THAT draft invoice.
 * Re-run inspect after adding the credit lines to verify the total still matches.
 * Only then finalize through the existing approved desk invoice workflow.
 * Any refusal/hold/error: do not finalize/collect; review with the owner.
 * Use mode reconcile after payment/void (dry-run maps to reconcile_preview).
 * A voided invoice releases credit; missing/unknown/uncollectible stays held.
 * Never release based on a clock, an email, or a stale webhook.
 * For a separately approved historical seed, mode backfill maps to
 * backfill_preview by default; --apply also requires the normally-off
 * AIH_CC_CREDIT_IMPORT_ENABLED server flag. Never enable it/run --apply as
 * part of an inventory. Keep AIH_CC_CREDIT_ENABLED off until the reviewed
 * history is seeded and all holds are resolved.
 */
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
	deskCreditMode,
	postCreditRequest,
} from '../src/lib/cc-credit/support-client'

async function main() {
	const { values } = parseArgs({
		options: {
			url: { type: 'string' },
			request: { type: 'string' },
			apply: { type: 'boolean', default: false },
		},
	})
	if (!values.url || !values.request)
		throw new Error('--url and --request are required')
	const input = JSON.parse(await readFile(values.request, 'utf8')) as Record<
		string,
		unknown
	>
	const mode = deskCreditMode(String(input.mode), values.apply)
	const result = await postCreditRequest(
		values.url,
		{ ...input, mode },
		process.env.SUPPORT_WEBHOOK_SECRET ?? '',
	)
	console.log(JSON.stringify({ dryRun: !values.apply, ...result }, null, 2))
	if (!result.ok) process.exitCode = 1
}
main().catch(() => {
	console.error(
		'CC credit command failed. No authorization to finalize; check inputs, credentials and ledger availability.',
	)
	process.exitCode = 1
})
