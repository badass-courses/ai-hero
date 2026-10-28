/** Read-only inventory and seed plan. There is deliberately NO --apply option.
 * pnpm exec tsx scripts/cc-credit-backfill.ts --url https://www.aihero.dev --out /private/cc-credit-plan.json
 * Or before runtime deployment:
 * pnpm exec tsx scripts/cc-credit-backfill.ts --local-db --out /private/cc-credit-plan.json
 *
 * Inject STRIPE_SECRET_TOKEN plus DATABASE_URL (read-only) for --local-db,
 * or SUPPORT_WEBHOOK_SECRET for --url. Never commit output.
 * --local-db uses SELECTs under the same purchase-lock transaction protocol;
 * it never calls insert/settle. Use read-only DB credentials.
 * Preview still takes FOR UPDATE locks on production AI_Purchase rows,
 * briefly, in one transaction per matched invoice. Run once off peak, not
 * in a polling loop: it can delay other work touching those purchases.
 * Run with reservations disabled. Review ALL holds before enabling. A separately
 * approved import uses scripts/cc-credit.ts mode backfill and the normally-off
 * AIH_CC_CREDIT_IMPORT_ENABLED flag. This inventory never enables it or imports.
 */
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import Stripe from 'stripe'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { C5_PRODUCT, CreditRefusal } from '../src/lib/cc-credit/domain'
import {
	inventoryCredits,
	type CreditInventoryPreview,
} from '../src/lib/cc-credit/inventory'
import { mysqlCreditStore } from '../src/lib/cc-credit/store'
import { runCreditCommand } from '../src/lib/cc-credit/service'
import { readCreditInvoice } from '../src/lib/cc-credit/stripe'
import {
	postCreditRequest,
	supportCreditUrl,
} from '../src/lib/cc-credit/support-client'

async function main() {
	const { values } = parseArgs({
		options: {
			url: { type: 'string' },
			out: { type: 'string' },
			customer: { type: 'string' },
			'local-db': { type: 'boolean', default: false },
		},
	})
	if ((!values.url && !values['local-db']) || !values.out)
		throw new Error('--url or --local-db and a private --out path are required')
	if (values.url) supportCreditUrl(values.url)
	const key = process.env.STRIPE_SECRET_TOKEN
	const secret = process.env.SUPPORT_WEBHOOK_SECRET
	if (!key || (!values['local-db'] && !secret))
		throw new Error(
			'Read-only Stripe and DB/support credentials required in environment',
		)
	const databaseUrl = values['local-db'] ? process.env.DATABASE_URL : undefined
	if (values['local-db'] && !databaseUrl)
		throw new Error('DATABASE_URL is required for --local-db')
	const loopback =
		databaseUrl &&
		['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
	const pool = databaseUrl
		? mysql.createPool({
				uri: databaseUrl,
				connectionLimit: 2,
				timezone: 'Z',
				...(!loopback ? { ssl: { rejectUnauthorized: true } } : {}),
			})
		: null
	try {
		const store = pool ? mysqlCreditStore(() => pool.getConnection()) : null
		const [mappings] = pool
			? await pool.execute<RowDataPacket[]>(
					'SELECT identifier FROM AI_MerchantProduct WHERE productId = ?',
					[C5_PRODUCT],
				)
			: [[]]
		const products = new Set(mappings.map((row) => String(row.identifier)))
		const stripe = new Stripe(key, {
			apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
		})
		const createdBefore = Math.floor(Date.now() / 1000)
		const plan = await inventoryCredits(
			{
				invoices: stripe.invoices.list({
					limit: 100,
					created: { lte: createdBefore },
					...(values.customer ? { customer: values.customer } : {}),
				}),
				lines: (id) => stripe.invoices.listLineItems(id, { limit: 100 }),
				preview: async (input) => {
					if (store) {
						try {
							if (!products.size)
								throw new CreditRefusal('c5_stripe_product_mapping_missing')
							const invoice = await readCreditInvoice(
								stripe,
								input.invoiceId,
								products,
							)
							return {
								ok: true,
								result: await runCreditCommand(store, { ...input, invoice }),
							}
						} catch (error) {
							return {
								ok: false,
								result: {
									reason:
										error instanceof CreditRefusal
											? error.reason
											: 'preview_unavailable',
								},
							}
						}
					}
					const result = await postCreditRequest(values.url!, input, secret!)
					return {
						ok: result.ok,
						result: result.result as CreditInventoryPreview,
					}
				},
			},
			`cc-credit-inventory-${createdBefore}`,
		)
		await writeFile(
			values.out,
			JSON.stringify(
				{
					dryRun: true,
					createdBefore,
					customerScoped: !!values.customer,
					...plan,
				},
				null,
				2,
			),
			{ mode: 0o600, flag: 'wx' },
		)
		console.log(
			JSON.stringify(
				{
					dryRun: true,
					createdBefore,
					customerScoped: !!values.customer,
					counts: plan.counts,
				},
				null,
				2,
			),
		)
		if (plan.counts.held > 0) process.exitCode = 2
	} finally {
		await pool?.end()
	}
}
main().catch(() => {
	console.error(
		'CC credit inventory failed. Output is incomplete; keep reservations and display disabled. No writes applied.',
	)
	process.exitCode = 1
})
