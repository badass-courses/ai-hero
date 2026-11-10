/**
 * Backfill purchase.recorded to drovr for purchases the ContactEvent mirror
 * skipped (Valid or Restricted, since --since, no purchase.recorded
 * ContactEvent). Buyers are resolved in drovr; only resolved ones are posted,
 * under the live path's purchase-id idempotency key, so a rerun is safe.
 *
 *   tsx scripts/purchase-recorded-backfill.ts [--since 2026-10-01]
 *     [--allow-write] [--snapshot <path>]
 *
 * Dry run by default: resolves and counts, posts nothing. --allow-write posts
 * at about 2 per second. --snapshot writes a 0600 file of
 * (purchaseId, drovrContactId, productId) before the first post. Stdout is
 * counts only. Exits non-zero on any transport failure and keeps what was
 * already posted.
 */
import { chmod, writeFile } from 'node:fs/promises'
import { sql } from 'drizzle-orm'

import { db } from '../src/db/client'
import {
	runPurchaseBackfill,
	type BackfillCounts,
	type BackfillPurchase,
} from '../src/lib/subscriber-marketing/drovr-purchase-backfill'
import {
	deliverResolvedPurchaseEvents,
	resolveDrovrContacts,
} from '../src/lib/subscriber-marketing/drovr-purchase-resolve'
import {
	DROVR_AUTHORITY_TENANT_ID,
	drovrApiKeyForTenant,
} from '../src/lib/subscriber-marketing/drovr-shadow-emitter'
import { resolveDrovrApiBaseUrl } from '../src/lib/subscriber-marketing/drovr-unsubscribe-page'

const argv = process.argv
const valueOf = (flag: string) => {
	const at = argv.indexOf(flag)
	return at > -1 ? argv[at + 1] : undefined
}
const since = valueOf('--since') ?? '2026-10-01'
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
	throw new Error('--since must be YYYY-MM-DD')
}
const allowWrite = argv.includes('--allow-write')
const snapshotPath = valueOf('--snapshot')
if (allowWrite && !snapshotPath) {
	throw new Error('--allow-write needs --snapshot <path>')
}

const rowsOf = <T>(result: unknown) =>
	(Array.isArray(result) ? result[0] : (result as any).rows) as T[]

async function missedPurchases(): Promise<BackfillPurchase[]> {
	const result = await db.execute(sql`
		SELECT p.id AS purchaseId, p.productId AS productId, p.status AS status,
			CAST(p.totalAmount AS CHAR) AS totalAmount, p.createdAt AS createdAt,
			LOWER(TRIM(u.email)) AS email
		FROM AI_Purchase p
		JOIN AI_User u ON u.id = p.userId
		WHERE p.status IN ('Valid', 'Restricted')
			AND p.createdAt >= ${since}
			AND u.email IS NOT NULL AND u.email <> ''
			AND NOT EXISTS (
				SELECT 1 FROM AI_ContactEvent ce
				WHERE ce.eventType = 'purchase.recorded'
					AND ce.semanticIdempotencyKey = LOWER(CONCAT('ai-hero:purchase.recorded:purchase:', p.id))
			)
		ORDER BY p.createdAt
	`)
	return rowsOf<{
		purchaseId: string
		productId: string
		status: string
		totalAmount: string
		createdAt: Date | string
		email: string
	}>(result).map((row) => ({
		purchaseId: row.purchaseId,
		productId: row.productId,
		status: row.status,
		totalAmount: row.totalAmount,
		purchasedAt: new Date(row.createdAt).toISOString(),
		email: row.email,
	}))
}

async function main() {
	const ingestUrl = process.env.DROVR_SHADOW_INGEST_URL?.trim()
	const baseUrl = resolveDrovrApiBaseUrl({
		DROVR_API_BASE_URL: process.env.DROVR_API_BASE_URL,
		DROVR_SHADOW_INGEST_URL: ingestUrl,
	})
	const apiKey = drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID, {
		authorityApiKey: process.env.DROVR_API_KEY_ORG_AIHERO,
	})
	if (!baseUrl || !apiKey || (allowWrite && !ingestUrl)) {
		throw new Error(
			'needs DROVR_API_KEY_ORG_AIHERO, DROVR_SHADOW_INGEST_URL, and DROVR_API_BASE_URL or the ingest URL',
		)
	}
	const counts: BackfillCounts = {
		purchases: 0,
		resolved: 0,
		missing: 0,
		conflict: 0,
		posted: 0,
		accepted: 0,
		rejected: 0,
		rejectedBy: {},
	}
	try {
		await runPurchaseBackfill({
			purchases: await missedPurchases(),
			allowWrite,
			counts,
			ingestConfig: ingestUrl ? { ingestUrl, apiKey } : undefined,
			ports: {
				resolve: (emails) =>
					resolveDrovrContacts({
						emails,
						config: { baseUrl, apiKey },
					}),
				deliver: deliverResolvedPurchaseEvents,
				writeSnapshot: async (rows) => {
					await writeFile(snapshotPath!, JSON.stringify(rows), {
						mode: 0o600,
					})
					await chmod(snapshotPath!, 0o600)
				},
				sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
			},
		})
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'failed')
		process.exitCode = 1
	} finally {
		console.log(
			JSON.stringify({
				mode: allowWrite ? 'write' : 'dry-run',
				since,
				...counts,
			}),
		)
	}
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? error.message : 'failed')
		process.exitCode = 1
	})
	.finally(() => process.exit())
