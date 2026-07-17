import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
	new URL('./google-ads-conversion-upload.ts', import.meta.url),
	'utf8',
)
const resolverStart = source.indexOf(
	'export function createGoogleAdsPurchaseFallbackResolver',
)
const resolverEnd = source.indexOf('function affectedRows', resolverStart)
const resolver = source.slice(resolverStart, resolverEnd)

describe('purchase conversion signup-gclid fallback query', () => {
	it('filters paid candidates before limiting the batch', () => {
		const queryStart = source.indexOf('async function fetchCandidatePurchases')
		const queryEnd = source.indexOf(
			'function normalizeKitSubscriberId',
			queryStart,
		)
		const query = source.slice(queryStart, queryEnd)
		expect(query).toContain("inArray(purchases.status, ['Valid', 'Restricted'])")
		expect(query).toContain('purchases.totalAmount')
		expect(query).toContain(
			'googleAdsConversionUpload.conversionActionResourceName',
		)
		expect(query).toContain('args.conversionActionResourceName')
		expect(query.indexOf('.where(')).toBeLessThan(query.indexOf('.limit('))
	})

	it('reclaims stale processing reservations with attempt-count compare-and-set guards', () => {
		const ledgerStart = source.indexOf(
			'export function createGoogleAdsPurchaseConversionLedger',
		)
		const ledgerEnd = source.indexOf(
			'export async function processGoogleAdsConversionUploads',
			ledgerStart,
		)
		const ledger = source.slice(ledgerStart, ledgerEnd)
		expect(ledger).toContain("['failed', 'pending', 'processing']")
		expect(ledger).toContain('googleAdsConversionUpload.lastAttemptAt')
		expect(ledger).toContain("eq(googleAdsConversionUpload.status, 'processing')")
		expect(ledger).toContain(
			'eq(googleAdsConversionUpload.attemptCount, attemptCount)',
		)
	})

	it('uses Contact as the only identity spine and resolves email before Kit provider identity', () => {
		expect(resolver).toContain('.from(contact)')
		expect(resolver).toContain("eq(providerIdentity.provider, 'kit')")
		expect(resolver).toContain('.from(contactState)')
		expect(resolver).toContain('attribution?.subscribedAt')
		expect(resolver).toContain("gclid.startsWith('TEST_')")
		expect(resolver.indexOf('.from(contact)')).toBeLessThan(
			resolver.indexOf('.from(providerIdentity)'),
		)
		expect(resolver).not.toContain('insert(')
	})
})
