/**
 * Dry run only. Counts Valid or Restricted purchases since a date that have no
 * purchase.recorded ContactEvent, grouped by product and kind. Issues one
 * SELECT, prints counts, and posts nothing: no ContactEvent, Contact or drovr
 * write. No ids or emails are read or printed.
 *
 *   tsx scripts/purchase-recorded-backfill-dry-run.ts [--since 2026-10-01] [--resolve]
 *
 * --resolve also asks drovr (read-only resolve_contacts, batches of 1000) who
 * the missed buyers with no ai-hero Contact are, and prints counts of
 * resolved, missing and conflict. Emails stay in memory and are never printed.
 *
 * kind: new-purchase (paid) or coupon-redeemed (zero total or a redeemed bulk
 * coupon, which includes seat redemptions).
 */
import { sql } from 'drizzle-orm'

import { db } from '../src/db/client'
import {
	DROVR_AUTHORITY_TENANT_ID,
	drovrApiKeyForTenant,
} from '../src/lib/subscriber-marketing/drovr-shadow-emitter'
import { resolveDrovrApiBaseUrl } from '../src/lib/subscriber-marketing/drovr-unsubscribe-page'
import { resolveDrovrContacts } from '../src/lib/subscriber-marketing/drovr-purchase-resolve'

const sinceArg = process.argv.indexOf('--since')
const since = sinceArg > -1 ? process.argv[sinceArg + 1] : '2026-10-01'
if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
	throw new Error('--since must be YYYY-MM-DD')
}

const missedPredicate = sql`
	p.status IN ('Valid', 'Restricted')
	AND p.createdAt >= ${since}
	AND NOT EXISTS (
		SELECT 1 FROM AI_ContactEvent ce
		WHERE ce.eventType = 'purchase.recorded'
			AND ce.semanticIdempotencyKey = LOWER(CONCAT('ai-hero:purchase.recorded:purchase:', p.id))
	)`

const rowsOf = <T>(result: unknown) =>
	(Array.isArray(result) ? result[0] : (result as any).rows) as T[]

/** Distinct emails of missed buyers that have no ai-hero Contact by user id or email. */
async function missedBuyerEmails() {
	const result = await db.execute(sql`
		SELECT DISTINCT LOWER(TRIM(u.email)) AS email
		FROM AI_Purchase p
		JOIN AI_User u ON u.id = p.userId
		WHERE ${missedPredicate}
			AND u.email IS NOT NULL AND u.email <> ''
			AND NOT EXISTS (SELECT 1 FROM AI_Contact c WHERE c.userId = u.id OR c.email = u.email)
	`)
	return rowsOf<{ email: string }>(result).map((row) => row.email)
}

async function resolveCounts() {
	const baseUrl = resolveDrovrApiBaseUrl({
		DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
		DROVR_SHADOW_INGEST_URL: process.env.DROVR_SHADOW_INGEST_URL,
	})
	const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID, {
		authorityApiKey: process.env.DROVR_API_KEY_ORG_AIHERO,
	})
	if (!baseUrl || !apiKey) {
		throw new Error(
			'--resolve needs DROVR_API_BASE_URL or DROVR_SHADOW_INGEST_URL, and DROVR_API_KEY_ORG_AIHERO',
		)
	}
	const emails = await missedBuyerEmails()
	const answers = await resolveDrovrContacts({
		emails,
		config: { baseUrl, apiKey },
	})
	const counts = {
		buyersWithoutContact: emails.length,
		resolved: 0,
		missing: 0,
		conflict: 0,
	}
	for (const answer of answers.values()) counts[answer.status] += 1
	console.log(JSON.stringify({ mode: 'dry-run-resolve', ...counts, posts: 0 }))
}

async function main() {
	if (process.argv.includes('--resolve')) await resolveCounts()
	// Key mirrors purchaseRecordedSemanticKey (lowercased).
	const result = await db.execute(sql`
		SELECT p.productId AS productId,
			CASE WHEN p.redeemedBulkCouponId IS NOT NULL OR p.totalAmount = 0
				THEN 'coupon-redeemed' ELSE 'new-purchase' END AS kind,
			COUNT(*) AS missed
		FROM AI_Purchase p
		WHERE p.status IN ('Valid', 'Restricted')
			AND p.createdAt >= ${since}
			AND NOT EXISTS (
				SELECT 1 FROM AI_ContactEvent ce
				WHERE ce.eventType = 'purchase.recorded'
					AND ce.semanticIdempotencyKey = LOWER(CONCAT('ai-hero:purchase.recorded:purchase:', p.id))
			)
		GROUP BY p.productId, kind
		ORDER BY missed DESC
	`)
	const rows = (
		Array.isArray(result) ? result[0] : (result as any).rows
	) as Array<{
		productId: string
		kind: string
		missed: number | string
	}>
	const byKind: Record<string, number> = {}
	let total = 0
	for (const row of rows) {
		const n = Number(row.missed)
		total += n
		byKind[row.kind] = (byKind[row.kind] ?? 0) + n
		console.log(`product=${row.productId} kind=${row.kind} missed=${n}`)
	}
	console.log(
		JSON.stringify({ since, total, byKind, mode: 'dry-run', writes: 0 }),
	)
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? error.message : 'failed')
		process.exitCode = 1
	})
	.finally(() => process.exit())
