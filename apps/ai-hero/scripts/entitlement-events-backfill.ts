/**
 * Backfill entitlement.granted (live included grants) and
 * entitlement.revoked (ended ones) to drovr for the included-product rows
 * that exist today. Facts the ContactEvent mirror already recorded are
 * skipped. Holders are resolved in drovr; only resolved ones are posted,
 * under the live path's idempotency keys, so a rerun changes nothing.
 *
 *   tsx scripts/entitlement-events-backfill.ts [--apply --snapshot <path>]
 *     [--limit <n>]
 *
 * Dry run by default: reads, resolves and counts, posts nothing. --apply
 * posts at about 2 per second and needs --snapshot, a 0600 file of
 * (entitlementId, change, drovrContactId) written before the first post.
 * --limit takes at most that many facts this run. Rows are read in pages of
 * 500. Stdout is counts only. Exits non-zero on any transport failure and
 * keeps what was already posted.
 */
import { chmod, writeFile } from 'node:fs/promises'
import { and, asc, gt, inArray, like } from 'drizzle-orm'

import { db } from '../src/db/client'
import { contactEvent, entitlements, users } from '../src/db/schema'
import { includedEntitlementFacts } from '../src/lib/included-product-entitlement-events'
import { INCLUDED_PRODUCTS } from '../src/lib/included-product-policy'
import {
	emptyEntitlementBackfillCounts,
	runEntitlementBackfill,
	type BackfillEntitlement,
} from '../src/lib/subscriber-marketing/drovr-entitlement-backfill'
import {
	deliverResolvedPurchaseEvents,
	resolveDrovrContacts,
} from '../src/lib/subscriber-marketing/drovr-purchase-resolve'
import {
	DROVR_AUTHORITY_TENANT_ID,
	drovrApiKeyForTenant,
} from '../src/lib/subscriber-marketing/drovr-shadow-emitter'
import { resolveDrovrApiBaseUrl } from '../src/lib/subscriber-marketing/drovr-unsubscribe-page'
import { entitlementRecordedSemanticKey } from '../src/lib/subscriber-marketing/lifecycle-contact-events'

const PAGE_SIZE = 500

const argv = process.argv
const valueOf = (flag: string) => {
	const at = argv.indexOf(flag)
	return at > -1 ? argv[at + 1] : undefined
}
const allowWrite = argv.includes('--apply')
const snapshotPath = valueOf('--snapshot')
if (allowWrite && !snapshotPath) {
	throw new Error('--apply needs --snapshot <path>')
}
const limitValue = valueOf('--limit')
if (limitValue !== undefined && !/^[1-9]\d*$/.test(limitValue)) {
	throw new Error('--limit must be a positive integer')
}
const limit = limitValue === undefined ? Infinity : Number(limitValue)

async function includedFacts() {
	const prefixes = [
		...new Set(
			Object.values(INCLUDED_PRODUCTS).flatMap((policies) =>
				policies.map((policy) => policy.idPrefix),
			),
		),
	]
	const now = new Date().toISOString()
	const facts: BackfillEntitlement[] = []
	let alreadyRecorded = 0
	let noEmail = 0
	for (const prefix of prefixes) {
		let cursor = ''
		for (;;) {
			const page = await db
				.select()
				.from(entitlements)
				.where(
					and(
						like(entitlements.id, `${prefix}%`),
						gt(entitlements.id, cursor),
					),
				)
				.orderBy(asc(entitlements.id))
				.limit(PAGE_SIZE)
			if (page.length === 0) break
			cursor = page[page.length - 1]!.id
			const pageFacts = includedEntitlementFacts(page, now)
			if (pageFacts.length === 0) continue
			const holderIds = [...new Set(pageFacts.map((fact) => fact.userId))]
			const holders = await db
				.select({ id: users.id, email: users.email, name: users.name })
				.from(users)
				.where(inArray(users.id, holderIds))
			const keyOf = (fact: (typeof pageFacts)[number]) =>
				entitlementRecordedSemanticKey(fact.change, fact.entitlementId)
			const people = new Map(holders.map((holder) => [holder.id, holder]))
			const recorded = new Set(
				(
					await db
						.select({ key: contactEvent.semanticIdempotencyKey })
						.from(contactEvent)
						.where(
							inArray(
								contactEvent.semanticIdempotencyKey,
								pageFacts.map(keyOf),
							),
						)
				).map((row) => row.key),
			)
			for (const fact of pageFacts) {
				if (recorded.has(keyOf(fact))) {
					alreadyRecorded += 1
					continue
				}
				const email = people.get(fact.userId)?.email?.trim().toLowerCase()
				if (!email) {
					noEmail += 1
					continue
				}
				facts.push({
					...fact,
					email,
					name: people.get(fact.userId)?.name ?? null,
				})
			}
			if (page.length < PAGE_SIZE) break
		}
	}
	return { facts: facts.slice(0, limit), alreadyRecorded, noEmail }
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
	const counts = emptyEntitlementBackfillCounts()
	let skipped = { alreadyRecorded: 0, noEmail: 0 }
	try {
		const read = await includedFacts()
		skipped = { alreadyRecorded: read.alreadyRecorded, noEmail: read.noEmail }
		await runEntitlementBackfill({
			facts: read.facts,
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
				...skipped,
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
