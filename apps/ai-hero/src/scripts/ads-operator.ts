import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { db } from '@/db'
import {
	contact,
	contactEvent,
	contactState,
	providerIdentity,
	sideEffectIntent,
	stateTransition,
	googleAdsSignupConversionUpload,
	merchantSession,
	products,
	purchases,
	shortlink,
	shortlinkAttribution,
} from '@/db/schema'
import {
	googleAdsRestUploadClient,
	processGoogleAdsConversionUploads,
	readGoogleAdsConversionUploadConfig,
} from '@/lib/google-ads-conversion-upload'
import { getAdsCourseFunnelMetrics, getAdsCourseMetrics } from '@/lib/ads-course-metrics'
import { buildSignupConversionPreview, prepareSignupConversionBatch } from '@/lib/google-ads-signup-conversion-upload'
import { log } from '@/server/logger'
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm'

const rangeOptions = ['24h', '7d', '30d', '90d', 'all'] as const
type Range = (typeof rangeOptions)[number]

type AttributionSnapshot = {
	utm?: Record<string, string | undefined>
	clickIds?: Record<string, string | undefined>
	shortlink?: { slug?: string | null }
	ga?: { clientId?: string }
	selfReportedSource?: string
	synthetic?: boolean
}

type AttributionFields = {
	attribution?: AttributionSnapshot
	utmSource?: string
	utmMedium?: string
	utmCampaign?: string
	gaClientId?: string
	shortlinkRef?: string
}

function readFlag(argv: readonly string[], flag: string) {
	const index = argv.indexOf(flag)
	return index >= 0 ? argv[index + 1] : undefined
}

function hasFlag(argv: readonly string[], flag: string) {
	return argv.includes(flag)
}

function parseArgs(argv: readonly string[]) {
	const [command = 'status'] = argv
	const rawRange = readFlag(argv, '--range') ?? '30d'
	const range = rangeOptions.includes(rawRange as Range)
		? (rawRange as Range)
		: '30d'
	const purchaseId = readFlag(argv, '--purchase-id')
	const contactId = readFlag(argv, '--contact-id')
	const email = readFlag(argv, '--email')
	const productId = readFlag(argv, '--product-id')
	const receipt = readFlag(argv, '--receipt')
	const rawLimit = Number(readFlag(argv, '--limit') ?? '500')
	const limit = Number.isFinite(rawLimit)
		? Math.min(Math.max(Math.trunc(rawLimit), 1), 5000)
		: 500
	const allowWrite = hasFlag(argv, '--allow-write')
	const dryRun = hasFlag(argv, '--dry-run') || !allowWrite
	const withStripe = hasFlag(argv, '--with-stripe')
	return {
		command,
		range,
		purchaseId,
		contactId,
		email,
		productId,
		receipt,
		limit,
		allowWrite,
		dryRun,
		withStripe,
	}
}

function sinceForRange(range: Range) {
	if (range === 'all') return null
	const now = new Date()
	const days = range === '24h' ? 1 : Number(range.replace('d', ''))
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseFields(fields: unknown): AttributionFields {
	return isRecord(fields) ? (fields as AttributionFields) : {}
}

function hasValue(record: Record<string, unknown> | undefined) {
	return Boolean(
		record &&
		Object.values(record).some(
			(value) => typeof value === 'string' && value.length > 0,
		),
	)
}

const googleOfflineClickIdKeys = ['gclid', 'gbraid', 'wbraid'] as const

function hasTestClickId(attribution: AttributionSnapshot | undefined) {
	return Boolean(
		attribution?.clickIds &&
		Object.values(attribution.clickIds).some(
			(value) => typeof value === 'string' && value.startsWith('TEST_'),
		),
	)
}

function realGoogleClickIdKeys(attribution: AttributionSnapshot | undefined) {
	return googleOfflineClickIdKeys.filter((key) => {
		const value = attribution?.clickIds?.[key]
		return (
			typeof value === 'string' &&
			value.length > 0 &&
			!value.startsWith('TEST_')
		)
	})
}

function summarizeFields(fields: unknown) {
	const parsed = parseFields(fields)
	const attribution = parsed.attribution
	const hasAttributionSnapshot = Boolean(attribution)
	const hasUtm = hasValue(attribution?.utm) || Boolean(parsed.utmSource)
	const hasClickId = hasValue(attribution?.clickIds)
	const hasShortlink = Boolean(
		attribution?.shortlink?.slug || parsed.shortlinkRef,
	)
	const hasGaClientId = Boolean(attribution?.ga?.clientId || parsed.gaClientId)
	const synthetic = Boolean(
		attribution?.synthetic || hasTestClickId(attribution),
	)

	return {
		hasAttributionSnapshot,
		hasUtm,
		hasClickId,
		hasShortlink,
		hasGaClientId,
		synthetic,
		attributed:
			hasAttributionSnapshot ||
			hasUtm ||
			hasClickId ||
			hasShortlink ||
			hasGaClientId,
	}
}

function parseJsonRecord(value: unknown) {
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown
			return isRecord(parsed) ? parsed : {}
		} catch {
			return {}
		}
	}
	return isRecord(value) ? value : {}
}

function affectedRows(result: unknown) {
	if (!isRecord(result)) return 0
	return Number(
		result.rowsAffected ?? result.affectedRows ?? result.rowCount ?? 0,
	)
}

function writeReceipt(path: string | undefined, payload: unknown) {
	if (!path) return null
	const resolved = resolve(path)
	mkdirSync(dirname(resolved), { recursive: true })
	writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`)
	return resolved
}

function buildShortlinkRecoverySnapshot(input: {
	attributionCreatedAt: Date | null
	shortlinkId: string | null
	shortlinkSlug: string | null
	shortlinkMetadata: unknown
	now?: Date
}) {
	return {
		schemaVersion: 1 as const,
		capturedAt: (
			input.attributionCreatedAt ??
			input.now ??
			new Date()
		).toISOString(),
		recoveredFrom: 'shortlink_attribution_table',
		recoveredAt: (input.now ?? new Date()).toISOString(),
		shortlink: {
			...(input.shortlinkId ? { id: input.shortlinkId } : {}),
			...(input.shortlinkSlug ? { slug: input.shortlinkSlug } : {}),
			metadata: parseJsonRecord(input.shortlinkMetadata),
		},
	}
}

function metadataValue(metadata: Record<string, string>, ...keys: string[]) {
	for (const key of keys) {
		const value = metadata[key]
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim()
		}
	}
	return undefined
}

function buildInvoiceAttributionSnapshot(input: {
	metadata: Record<string, string>
	now?: Date
}) {
	const frontConversationId = metadataValue(
		input.metadata,
		'frontConversationId',
		'conversationId',
	)
	const operatorRunId = metadataValue(input.metadata, 'operatorRunId')
	const explicitSource = metadataValue(input.metadata, 'source')
	const inferredSource = input.metadata.purchaseBenefits
		? 'team_sale'
		: frontConversationId || operatorRunId || input.metadata.createdBy
			? 'manual_invoice'
			: undefined
	const source = explicitSource ?? inferredSource
	const medium =
		metadataValue(input.metadata, 'medium') ?? (source ? 'invoice' : undefined)
	const campaign = metadataValue(input.metadata, 'campaign')

	if (
		!source &&
		!medium &&
		!campaign &&
		!frontConversationId &&
		!operatorRunId
	) {
		return undefined
	}

	return {
		schemaVersion: 1 as const,
		capturedAt: (input.now ?? new Date()).toISOString(),
		...(source && { source }),
		...(medium && { medium }),
		...(campaign && { campaign }),
		...(frontConversationId && { frontConversationId }),
		...(operatorRunId && { operatorRunId }),
	}
}

async function status(range: Range) {
	const since = sinceForRange(range)
	const conditions = [inArray(purchases.status, ['Valid', 'Restricted'])]
	if (since) conditions.push(gte(purchases.createdAt, since))

	const [totalRow] = await db
		.select({ total: count() })
		.from(purchases)
		.where(and(...conditions))

	const rows = await db
		.select({
			id: purchases.id,
			fields: purchases.fields,
			productId: purchases.productId,
			country: purchases.country,
			createdAt: purchases.createdAt,
		})
		.from(purchases)
		.where(and(...conditions))

	const byProduct: Record<
		string,
		{ totalPurchases: number; attributed: number; withClickId: number }
	> = {}
	const byCountryTier: Record<
		string,
		{ totalPurchases: number; attributed: number }
	> = {}
	const summary = rows.reduce(
		(acc, row) => {
			const fieldSummary = summarizeFields(row.fields)
			const productKey = row.productId ?? 'unknown'
			const product = byProduct[productKey] ?? {
				totalPurchases: 0,
				attributed: 0,
				withClickId: 0,
			}
			product.totalPurchases += 1
			if (fieldSummary.attributed) product.attributed += 1
			if (fieldSummary.hasClickId) product.withClickId += 1
			byProduct[productKey] = product

			const countryTier = classifyCountryTier(row.country)
			const tier = byCountryTier[countryTier] ?? {
				totalPurchases: 0,
				attributed: 0,
			}
			tier.totalPurchases += 1
			if (fieldSummary.attributed) tier.attributed += 1
			byCountryTier[countryTier] = tier

			if (fieldSummary.hasAttributionSnapshot) acc.withAttributionSnapshot += 1
			if (fieldSummary.hasUtm) acc.withUtm += 1
			if (fieldSummary.hasClickId) acc.withClickId += 1
			if (fieldSummary.hasShortlink) acc.withShortlink += 1
			if (fieldSummary.hasGaClientId) acc.withGaClientId += 1
			if (fieldSummary.synthetic) acc.synthetic += 1
			if (fieldSummary.attributed) acc.attributed += 1
			return acc
		},
		{
			totalPurchases: totalRow?.total ?? 0,
			attributed: 0,
			withAttributionSnapshot: 0,
			withUtm: 0,
			withClickId: 0,
			withShortlink: 0,
			withGaClientId: 0,
			synthetic: 0,
		},
	)

	return {
		ready: false,
		phase: 'instrumentation',
		verdict:
			summary.withAttributionSnapshot > 0 && summary.withClickId > 0
				? 'partial'
				: 'blocked',
		attributionCoverage: {
			...summary,
			unattributed: summary.totalPurchases - summary.attributed,
			coverageRate:
				summary.totalPurchases > 0
					? summary.attributed / summary.totalPurchases
					: 0,
			byProduct,
			byCountryTier,
		},
		checks: {
			purchaseAttributionSnapshot:
				summary.withAttributionSnapshot > 0 ? 'pass' : 'missing',
			paidClickIdPersistence: summary.withClickId > 0 ? 'pass' : 'missing',
			utmPersistence: summary.withUtm > 0 ? 'pass' : 'missing',
			syntheticReceipt: summary.synthetic > 0 ? 'pass' : 'missing',
		},
	}
}

function classifyCountryTier(country: string | null) {
	if (!country) return 'unknown'
	const normalized = country.toUpperCase()
	if (
		['US', 'GB', 'CA', 'AU', 'DE', 'NL', 'CH', 'SE', 'DK', 'FR'].includes(
			normalized,
		)
	)
		return 'tier_a_high_atv'
	if (
		['PL', 'ES', 'IT', 'BE', 'PT', 'CZ', 'IE', 'NZ', 'SG', 'IL'].includes(
			normalized,
		)
	)
		return 'tier_b_volume'
	if (['IN', 'BR', 'MX', 'AR'].includes(normalized)) return 'tier_c_ppp'
	return 'other'
}

function pickLegacyFields(fields: AttributionFields & Record<string, unknown>) {
	return Object.fromEntries(
		[
			'utmSource',
			'utmMedium',
			'utmCampaign',
			'gaClientId',
			'shortlinkRef',
			'landingPath',
			'referrer',
			'ltUtmSource',
			'ltUtmMedium',
			'ltUtmCampaign',
		]
			.map((key) => [key, fields[key]])
			.filter(([, value]) => value !== undefined && value !== null),
	)
}

async function syntheticReceipt(args: { purchaseId?: string; limit: number }) {
	const rows = args.purchaseId
		? await db
				.select({
					id: purchases.id,
					createdAt: purchases.createdAt,
					productId: purchases.productId,
					totalAmount: purchases.totalAmount,
					status: purchases.status,
					country: purchases.country,
					fields: purchases.fields,
				})
				.from(purchases)
				.where(eq(purchases.id, args.purchaseId))
				.limit(1)
		: await db
				.select({
					id: purchases.id,
					createdAt: purchases.createdAt,
					productId: purchases.productId,
					totalAmount: purchases.totalAmount,
					status: purchases.status,
					country: purchases.country,
					fields: purchases.fields,
				})
				.from(purchases)
				.where(
					and(
						inArray(purchases.status, ['Valid', 'Restricted']),
						sql`(
							JSON_EXTRACT(${purchases.fields}, '$.attribution.synthetic') = true
							OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.clickIds.gclid')) LIKE 'TEST\\_%'
							OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.clickIds.gbraid')) LIKE 'TEST\\_%'
							OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.clickIds.wbraid')) LIKE 'TEST\\_%'
							OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.clickIds.fbclid')) LIKE 'TEST\\_%'
							OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.clickIds.li_fat_id')) LIKE 'TEST\\_%'
							OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.clickIds.ttclid')) LIKE 'TEST\\_%'
							OR JSON_UNQUOTE(JSON_EXTRACT(${purchases.fields}, '$.attribution.clickIds.twclid')) LIKE 'TEST\\_%'
						)`,
					),
				)
				.orderBy(desc(purchases.createdAt))
				.limit(args.limit)

	const candidate = rows.find((row) => summarizeFields(row.fields).synthetic)
	const target = args.purchaseId ? rows[0] : candidate
	if (!target) {
		return {
			ready: false,
			verdict: 'missing',
			purchase: null,
			checks: {
				purchaseFound: args.purchaseId ? rows.length > 0 : false,
				syntheticMarker: false,
				attributionSnapshot: false,
				utm: false,
				clickId: false,
				gaClientId: false,
			},
			note: args.purchaseId
				? 'Purchase was not found.'
				: 'No synthetic attribution purchase found in the inspected recent purchase window.',
		}
	}

	const fields = parseFields(target.fields)
	const summary = summarizeFields(target.fields)
	return {
		ready:
			summary.synthetic &&
			summary.hasAttributionSnapshot &&
			summary.hasUtm &&
			summary.hasClickId,
		verdict:
			summary.synthetic &&
			summary.hasAttributionSnapshot &&
			summary.hasUtm &&
			summary.hasClickId
				? 'pass'
				: 'blocked',
		purchase: {
			id: target.id,
			createdAt: target.createdAt,
			productId: target.productId,
			totalAmount: target.totalAmount,
			status: target.status,
			country: target.country,
		},
		checks: {
			purchaseFound: true,
			syntheticMarker: summary.synthetic,
			attributionSnapshot: summary.hasAttributionSnapshot,
			utm: summary.hasUtm,
			clickId: summary.hasClickId,
			shortlink: summary.hasShortlink,
			gaClientId: summary.hasGaClientId,
		},
		attribution: fields.attribution ?? null,
	}
}

async function checkoutReceipt(args: { purchaseId?: string }) {
	if (!args.purchaseId) {
		return {
			ready: false,
			verdict: 'missing_purchase_id',
			purchase: null,
			checks: {
				purchaseFound: false,
				attributionSnapshot: false,
				utm: false,
				clickId: false,
				synthetic: false,
				shortlink: false,
				gaClientId: false,
				selfReportedSource: false,
			},
			attribution: null,
			legacy: {},
			fieldKeys: [],
		}
	}

	const [row] = await db
		.select({
			id: purchases.id,
			createdAt: purchases.createdAt,
			productId: purchases.productId,
			productName: products.name,
			totalAmount: purchases.totalAmount,
			status: purchases.status,
			country: purchases.country,
			fields: purchases.fields,
		})
		.from(purchases)
		.leftJoin(products, eq(purchases.productId, products.id))
		.where(eq(purchases.id, args.purchaseId))
		.limit(1)

	if (!row) {
		return {
			ready: false,
			verdict: 'not_found',
			purchase: null,
			checks: {
				purchaseFound: false,
				attributionSnapshot: false,
				utm: false,
				clickId: false,
				synthetic: false,
				shortlink: false,
				gaClientId: false,
				selfReportedSource: false,
			},
			attribution: null,
			legacy: {},
			fieldKeys: [],
		}
	}

	const fields = parseFields(row.fields) as AttributionFields &
		Record<string, unknown>
	const summary = summarizeFields(row.fields)
	return {
		ready: true,
		verdict: summary.attributed ? 'attributed' : 'dark',
		purchase: {
			id: row.id,
			createdAt: row.createdAt,
			productId: row.productId,
			productName: row.productName ?? null,
			totalAmount: row.totalAmount,
			status: row.status,
			country: row.country,
		},
		checks: {
			purchaseFound: true,
			attributionSnapshot: summary.hasAttributionSnapshot,
			utm: summary.hasUtm,
			clickId: summary.hasClickId,
			synthetic: summary.synthetic,
			shortlink: summary.hasShortlink,
			gaClientId: summary.hasGaClientId,
			selfReportedSource: Boolean(fields.attribution?.selfReportedSource),
		},
		attribution: fields.attribution ?? null,
		legacy: pickLegacyFields(fields),
		fieldKeys: Object.keys(fields).sort(),
	}
}

async function shortlinkBackfill(args: {
	range: Range
	productId?: string
	receipt?: string
	limit: number
	dryRun: boolean
	allowWrite: boolean
}) {
	const since = sinceForRange(args.range)
	const conditions: any[] = [
		inArray(purchases.status, ['Valid', 'Restricted']),
		sql`${purchases.totalAmount} > 0`,
		sql`JSON_EXTRACT(${purchases.fields}, '$.attribution') IS NULL`,
	]
	if (since) conditions.push(gte(purchases.createdAt, since))
	if (args.productId) conditions.push(eq(purchases.productId, args.productId))

	const rows = await db
		.select({
			purchaseId: purchases.id,
			totalAmount: purchases.totalAmount,
			fields: purchases.fields,
			shortlinkId: shortlinkAttribution.shortlinkId,
			shortlinkSlug: shortlink.slug,
			shortlinkMetadata: shortlink.metadata,
			attributionCreatedAt: shortlinkAttribution.createdAt,
		})
		.from(purchases)
		.innerJoin(
			shortlinkAttribution,
			and(
				eq(shortlinkAttribution.type, 'purchase'),
				sql`JSON_VALID(${shortlinkAttribution.metadata})`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${shortlinkAttribution.metadata}, '$.purchaseId')) = ${purchases.id}`,
			),
		)
		.leftJoin(shortlink, eq(shortlink.id, shortlinkAttribution.shortlinkId))
		.where(and(...conditions))

	const byPurchase = new Map<string, (typeof rows)[number]>()
	for (const row of rows) {
		if (!byPurchase.has(row.purchaseId)) byPurchase.set(row.purchaseId, row)
	}
	const candidates = [...byPurchase.values()].slice(0, args.limit)

	let appliedCount = 0
	let appliedRevenue = 0
	if (args.allowWrite && !args.dryRun) {
		for (const row of candidates) {
			const existingFields = parseJsonRecord(row.fields)
			if (isRecord(existingFields.attribution)) continue
			const attribution = buildShortlinkRecoverySnapshot({
				attributionCreatedAt: row.attributionCreatedAt ?? null,
				shortlinkId: row.shortlinkId ?? null,
				shortlinkSlug: row.shortlinkSlug ?? null,
				shortlinkMetadata: row.shortlinkMetadata,
			})
			const updateResult = await db
				.update(purchases)
				.set({ fields: { ...existingFields, attribution } })
				.where(
					and(
						eq(purchases.id, row.purchaseId),
						sql`JSON_EXTRACT(${purchases.fields}, '$.attribution') IS NULL`,
					),
				)
			if (affectedRows(updateResult) > 0) {
				appliedCount += 1
				appliedRevenue += Number(row.totalAmount ?? 0)
			}
		}
	}

	const candidateRevenue = candidates.reduce(
		(total, row) => total + Number(row.totalAmount ?? 0),
		0,
	)
	const payload = {
		ready: true,
		verdict: args.allowWrite && !args.dryRun ? 'applied' : 'dry_run',
		writeStatus:
			args.allowWrite && !args.dryRun ? 'write_attempted' : 'no_write',
		label: 'recovered_from_shortlink_attribution_table',
		range: args.range,
		productId: args.productId ?? null,
		candidatePurchases: candidates.length,
		candidateRevenue,
		appliedPurchases: appliedCount,
		appliedRevenue,
		preservedExistingAttribution: true,
		idempotency: 'only purchases with missing fields.attribution are eligible',
		notes: [
			'Aggregate receipt only. Purchase IDs and customer data are intentionally omitted.',
			'Exact evidence requires ShortlinkAttribution.type purchase and metadata.purchaseId equal to Purchase.id.',
		],
	}
	const receiptPath = writeReceipt(args.receipt, payload)
	return { ...payload, receiptPath }
}

async function fetchStripeInvoiceMetadata(invoiceId: string) {
	const apiKey =
		process.env.STRIPE_SECRET_TOKEN ??
		process.env.STRIPE_SECRET_KEY ??
		process.env.STRIPE_API_KEY
	if (!apiKey) return null
	try {
		const response = await fetch(
			`https://api.stripe.com/v1/invoices/${invoiceId}`,
			{
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(10_000),
			},
		)
		if (!response.ok) return null
		const invoice = (await response.json()) as {
			metadata?: Record<string, string>
		}
		return invoice.metadata ?? {}
	} catch {
		return null
	}
}

async function offlineConversionPreview(args: {
	range: Range
	productId?: string
	receipt?: string
	limit: number
	allowWrite: boolean
	dryRun: boolean
}) {
	const since = sinceForRange(args.range)
	if (args.productId === 'email-course') {
		const rows = await db.select({ contactId: contact.id, attribution: contactState.optInAttribution, updatedAt: contactState.updatedAt })
			.from(contactState).innerJoin(contact, eq(contact.id, contactState.contactId))
			.orderBy(desc(contactState.updatedAt))
			.limit(args.limit)
		const candidates = rows.flatMap((row) => {
			const attribution = row.attribution as any
			const occurredAt = attribution?.subscribedAt
			return attribution && occurredAt ? [{ contactId: row.contactId, occurredAt, attribution }] : []
		})
		const ranged = since ? candidates.filter((row) => new Date(row.occurredAt) >= since) : candidates
		const preview = buildSignupConversionPreview(ranged)
		const actionResource = process.env.GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_RESOURCE_NAME
		const batch = prepareSignupConversionBatch({ candidates: ranged, conversionActionResourceName: actionResource })
		const writeAttempted = args.allowWrite && !args.dryRun
		await log.info('subscriber_funnel.conversion_eligibility', {
			funnel: 'skills-newsletter', range: args.range,
			scanned: batch.counts.scanned, eligible: batch.counts.eligible,
			excluded: batch.counts.excluded, writeAttempted,
		})
		if (writeAttempted && !actionResource) throw new Error('GOOGLE_ADS_SIGNUP_CONVERSION_ACTION_RESOURCE_NAME is required for signup uploads')
		let uploaded = 0; let idempotentNoop = 0; let failed = 0
		if (writeAttempted) {
			const config = readGoogleAdsConversionUploadConfig({ enabled: true, conversionActionResourceName: actionResource })
			for (const conversion of batch.prepared) {
				const existing = await db.select({ status: googleAdsSignupConversionUpload.status }).from(googleAdsSignupConversionUpload).where(eq(googleAdsSignupConversionUpload.idempotencyKey, conversion.idempotencyKey)).limit(1)
				if (existing[0]?.status === 'uploaded' || existing[0]?.status === 'processing') { idempotentNoop += 1; continue }
				if (existing[0]?.status === 'failed' && process.env.AIH_GOOGLE_ADS_SIGNUP_RETRY_FAILED !== 'true') { idempotentNoop += 1; continue }
				if (existing[0]?.status === 'failed') {
					const reservation = await db.update(googleAdsSignupConversionUpload).set({ status: 'processing', attemptCount: sql`${googleAdsSignupConversionUpload.attemptCount} + 1`, updatedAt: new Date() }).where(and(eq(googleAdsSignupConversionUpload.idempotencyKey, conversion.idempotencyKey), eq(googleAdsSignupConversionUpload.status, 'failed')))
					if (Number((reservation as any).rowsAffected ?? (reservation as any)[0]?.affectedRows ?? 0) === 0) { idempotentNoop += 1; continue }
				} else {
					try {
						await db.insert(googleAdsSignupConversionUpload).values({ contactId: conversion.contactId, conversionActionResourceName: conversion.conversionActionResourceName, clickIdType: conversion.clickIdType, clickIdHash: conversion.clickIdHash, conversionDateTime: conversion.conversionDateTime, status: 'processing', attemptCount: 1, idempotencyKey: conversion.idempotencyKey, requestSummary: conversion.requestSummary })
					} catch { idempotentNoop += 1; continue }
				}
				try {
					const response = await googleAdsRestUploadClient.upload({ ...conversion, purchaseId: conversion.contactId }, config)
					await db.update(googleAdsSignupConversionUpload).set({ status: response.status, responseSummary: response, updatedAt: new Date() }).where(eq(googleAdsSignupConversionUpload.idempotencyKey, conversion.idempotencyKey))
					if (response.status === 'uploaded') uploaded += 1
					else if (response.status === 'failed') failed += 1
				} catch (error) {
					await db.update(googleAdsSignupConversionUpload).set({ status: 'failed', responseSummary: { error: error instanceof Error ? error.message : String(error) }, updatedAt: new Date() }).where(eq(googleAdsSignupConversionUpload.idempotencyKey, conversion.idempotencyKey))
					failed += 1
				}
			}
		}
		const payload = {
			ready: true, verdict: writeAttempted ? (failed ? 'upload_failed' : 'upload_processed') : 'preview', writeStatus: writeAttempted ? 'write_attempted' : 'no_write', range: args.range,
			productId: 'email-course', preview: preview.counts, previewRows: preview.rows, ...batch.counts, uploaded, idempotentNoop, failed,
			privacy: 'aggregate-only-no-click-ids-no-emails-no-contact-ids',
			notes: ['Signup candidates come from durable ContactState optInAttribution.', 'TEST_ click IDs are excluded from upload eligibility.', 'Writes require --allow-write, a live signup action resource, Google credentials, and the signup idempotency ledger.'],
		}
		const receiptPath = writeReceipt(args.receipt, payload)
		return { ...payload, receiptPath }
	}
	const uploadResult = await processGoogleAdsConversionUploads({
		database: db,
		config: readGoogleAdsConversionUploadConfig({
			enabled: args.allowWrite && !args.dryRun,
		}),
		productId: args.productId,
		since,
		limit: args.limit,
		dryRun: args.dryRun,
	})
	const writeAttempted = args.allowWrite && !args.dryRun
	const payload = {
		ready: true,
		verdict: writeAttempted
			? uploadResult.failed > 0
				? 'upload_failed'
				: 'upload_processed'
			: 'preview',
		writeStatus: writeAttempted ? 'write_attempted' : 'no_write',
		range: args.range,
		productId: args.productId ?? null,
		...uploadResult,
		uploadLedger: {
			enabled: true,
			note: 'Uploads are idempotent through AI_GoogleAdsConversionUpload. Raw click IDs are not stored in the ledger.',
		},
		notes: [
			'Raw Google click IDs and emails are intentionally omitted from output.',
			'Eligible rows require a real gclid, gbraid, or wbraid and exclude TEST_ click IDs.',
			'Exactly one Google click ID is uploaded per purchase, prioritizing gclid, then gbraid, then wbraid.',
		],
	}
	const receiptPath = writeReceipt(args.receipt, payload)
	return { ...payload, receiptPath }
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<R>,
) {
	const results: R[] = []
	let nextIndex = 0
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				results[index] = await worker(items[index]!)
			}
		},
	)
	await Promise.all(workers)
	return results
}

async function invoiceAttributionAudit(args: {
	range: Range
	productId?: string
	receipt?: string
	limit: number
	dryRun: boolean
	allowWrite: boolean
	withStripe: boolean
}) {
	const since = sinceForRange(args.range)
	const conditions: any[] = [
		inArray(purchases.status, ['Valid', 'Restricted']),
		sql`${purchases.totalAmount} > 0`,
		sql`${merchantSession.identifier} LIKE 'in_%'`,
	]
	if (since) conditions.push(gte(purchases.createdAt, since))
	if (args.productId) conditions.push(eq(purchases.productId, args.productId))

	const rows = await db
		.select({
			purchaseId: purchases.id,
			totalAmount: purchases.totalAmount,
			fields: purchases.fields,
			invoiceId: merchantSession.identifier,
		})
		.from(purchases)
		.innerJoin(
			merchantSession,
			eq(purchases.merchantSessionId, merchantSession.id),
		)
		.where(and(...conditions))
		.limit(args.limit)

	let attributedPurchases = 0
	let attributedRevenue = 0
	let darkPurchases = 0
	let darkRevenue = 0
	let exactEvidencePurchases = 0
	let exactEvidenceRevenue = 0
	let fuzzyEvidencePurchases = 0
	let fuzzyEvidenceRevenue = 0
	let appliedPurchases = 0
	let appliedRevenue = 0
	let stripeMetadataChecked = 0
	const darkRows = rows.filter((row) => !summarizeFields(row.fields).attributed)
	const stripeLookups = new Map<string, Record<string, string> | null>()
	if (args.withStripe) {
		const lookupResults = await mapWithConcurrency(
			darkRows,
			4,
			async (row) => ({
				purchaseId: row.purchaseId,
				metadata: await fetchStripeInvoiceMetadata(row.invoiceId),
			}),
		)
		for (const result of lookupResults) {
			stripeLookups.set(result.purchaseId, result.metadata)
		}
	}

	for (const row of rows) {
		const summary = summarizeFields(row.fields)
		const revenue = Number(row.totalAmount ?? 0)
		if (summary.attributed) {
			attributedPurchases += 1
			attributedRevenue += revenue
			continue
		}

		darkPurchases += 1
		darkRevenue += revenue
		const metadata = args.withStripe
			? (stripeLookups.get(row.purchaseId) ?? null)
			: null
		if (metadata) stripeMetadataChecked += 1
		const attribution = metadata
			? buildInvoiceAttributionSnapshot({ metadata })
			: undefined

		if (attribution) {
			exactEvidencePurchases += 1
			exactEvidenceRevenue += revenue
			if (args.allowWrite && !args.dryRun) {
				const existingFields = parseJsonRecord(row.fields)
				const updateResult = await db
					.update(purchases)
					.set({ fields: { ...existingFields, attribution } })
					.where(
						and(
							eq(purchases.id, row.purchaseId),
							sql`JSON_EXTRACT(${purchases.fields}, '$.attribution') IS NULL`,
						),
					)
				if (affectedRows(updateResult) > 0) {
					appliedPurchases += 1
					appliedRevenue += revenue
				}
			}
		} else {
			fuzzyEvidencePurchases += 1
			fuzzyEvidenceRevenue += revenue
		}
	}

	const payload = {
		ready: true,
		verdict: args.allowWrite && !args.dryRun ? 'applied' : 'audit_only',
		writeStatus:
			args.allowWrite && !args.dryRun ? 'write_attempted' : 'no_write',
		range: args.range,
		productId: args.productId ?? null,
		invoicePurchases: rows.length,
		invoiceRevenue: rows.reduce(
			(total, row) => total + Number(row.totalAmount ?? 0),
			0,
		),
		attributedPurchases,
		attributedRevenue,
		darkPurchases,
		darkRevenue,
		exactEvidencePurchases,
		exactEvidenceRevenue,
		fuzzyEvidencePurchases,
		fuzzyEvidenceRevenue,
		stripeLookup: {
			enabled: args.withStripe,
			metadataChecked: stripeMetadataChecked,
		},
		appliedPurchases,
		appliedRevenue,
		notes: [
			'Aggregate receipt only. Invoice IDs, purchase IDs, and customer data are intentionally omitted.',
			'Exact evidence requires approved invoice metadata keys from Stripe metadata.',
			'MerchantSession invoice evidence without approved metadata remains report-only fuzzy evidence.',
		],
	}
	const receiptPath = writeReceipt(args.receipt, payload)
	return { ...payload, receiptPath }
}

function maskEmail(value: string | null | undefined) {
	if (!value?.includes('@')) return null
	const [local, domain] = value.split('@')
	return `${local?.slice(0, 2) ?? ''}***@${domain}`
}

async function funnelStatus(range: Range) {
	const metricsRange = range === '7d' || range === '30d' ? range : 'today'
	const metrics = await getAdsCourseFunnelMetrics({ range: metricsRange })
	const legacyStages = Object.fromEntries(
		Object.entries(metrics.stages).map(([key, value]) => [key, { today: value.range, total: value.total }]),
	)
	return {
		...metrics,
		stages: legacyStages,
		dropOff: {
			eventToContact: metrics.dropOff.eventToContact.total,
			contactToEmailZero: metrics.dropOff.contactToEmailZero.total,
			emailZeroToSent: metrics.dropOff.emailZeroToSent.total,
		},
		attribution: { today: metrics.attribution.range, total: metrics.attribution.total },
		conversion: { today: metrics.conversion.range, total: metrics.conversion.total },
	}
}

async function funnelTrace(contactId?: string, email?: string) {
	if (!contactId && !email) throw new Error('funnel-trace requires --contact-id or --email')
	const rows = await db.select().from(contact).where(contactId ? eq(contact.id, contactId) : eq(contact.email, email!.trim().toLowerCase())).limit(2)
	if (rows.length !== 1) throw new Error(rows.length ? 'lookup matched more than one contact; use --contact-id' : 'contact not found')
	const found = rows[0]!
	const [events, transitions, intents, conversions, identities] = await Promise.all([
		db.select().from(contactEvent).where(eq(contactEvent.contactId, found.id)).orderBy(contactEvent.occurredAt),
		db.select().from(stateTransition).where(eq(stateTransition.contactId, found.id)).orderBy(stateTransition.createdAt),
		db.select().from(sideEffectIntent).where(eq(sideEffectIntent.contactId, found.id)).orderBy(sideEffectIntent.createdAt),
		db.select().from(googleAdsSignupConversionUpload).where(eq(googleAdsSignupConversionUpload.contactId, found.id)).orderBy(googleAdsSignupConversionUpload.createdAt),
		db.select().from(providerIdentity).where(eq(providerIdentity.contactId, found.id)).orderBy(providerIdentity.createdAt),
	])
	return { generatedAt: new Date().toISOString(), readOnly: true, contact: { id: found.id, email: maskEmail(found.email), lifecycle: found.lifecycle, createdAt: found.createdAt, attributionCaptured: Boolean(found.optInAttribution) }, identities: identities.map((row) => ({ provider: row.provider, createdAt: row.createdAt })), events: events.map((row) => ({ at: row.occurredAt, id: row.id, type: row.eventType, provider: row.provider })), transitions: transitions.map((row) => ({ at: row.createdAt, eventId: row.eventId, toStateId: row.toStateId })), intents: intents.map((row) => ({ at: row.createdAt, id: row.id, type: row.type, status: row.status, emailResourceId: parseJsonRecord(row.metadata).emailResourceId ?? null, completedAt: parseJsonRecord(row.metadata).completedAt ?? null, failedAt: parseJsonRecord(row.metadata).failedAt ?? null, reviewReasons: row.reviewReasons })), conversions: conversions.map((row) => ({ at: row.createdAt, status: row.status, clickIdType: row.clickIdType, attemptCount: row.attemptCount, updatedAt: row.updatedAt })) }
}

function nextActions() {
	return [
		{
			command: 'bin/aih-ads status [--range <range>]',
			description: 'Re-run ads attribution status',
			params: { range: { default: '30d', enum: rangeOptions } },
		},
		{
			command:
				'bin/aih-ads synthetic-receipt [--purchase-id <id>] [--limit 500]',
			description: 'Verify synthetic purchase attribution snapshot readiness',
		},
		{
			command: 'bin/aih-ads checkout-receipt --purchase-id <id>',
			description: 'Read one purchase checkout attribution receipt',
		},
		{
			command:
				'bin/aih-ads dark-revenue-shortlink-backfill --dry-run --product-id product-pqkk5 --receipt <path>',
			description:
				'Dry-run exact shortlink attribution recovery backfill with aggregate receipt only',
		},
		{
			command:
				'bin/aih-ads invoice-attribution-audit --product-id product-pqkk5 --receipt <path>',
			description:
				'Audit historical invoice attribution evidence with aggregate receipt only',
		},
		{
			command:
				'bin/aih-ads offline-conversion-preview --product-id product-pqkk5 --range 30d --receipt <path>',
			description:
				'Preview real Google Ads offline conversion eligibility with aggregate output only',
		},
	]
}

const {
	command,
	range,
	purchaseId,
	contactId,
	email,
	productId,
	receipt,
	limit,
	dryRun,
	allowWrite,
	withStripe,
} = parseArgs(process.argv.slice(2))

try {
	const result =
		command === 'status'
			? await status(range)
			: command === 'funnel-status'
				? await funnelStatus(range)
				: command === 'ads-course-metrics'
					? await getAdsCourseMetrics({ productId: productId ?? 'email-course', range: range === '7d' || range === '30d' ? range : 'today' })
				: command === 'funnel-trace'
					? await funnelTrace(contactId, email)
			: command === 'synthetic-receipt'
				? await syntheticReceipt({ purchaseId, limit })
				: command === 'checkout-receipt'
					? await checkoutReceipt({ purchaseId })
					: command === 'dark-revenue-shortlink-backfill'
						? await shortlinkBackfill({
								range,
								productId,
								receipt,
								limit,
								dryRun,
								allowWrite,
							})
						: command === 'invoice-attribution-audit'
							? await invoiceAttributionAudit({
									range,
									productId,
									receipt,
									limit,
									dryRun,
									allowWrite,
									withStripe,
								})
							: command === 'offline-conversion-preview' ||
								  command === 'offline-conversion-upload'
								? await offlineConversionPreview({
										range,
										productId,
										receipt,
										limit,
										dryRun,
										allowWrite,
									})
								: undefined
	if (!result) {
		throw new Error(`Unsupported command: ${command}`)
	}
	console.log(
		JSON.stringify(
			{
				ok: true,
				command: `ads-operator ${command}`,
				result,
				next_actions: nextActions(),
			},
			null,
			2,
		),
	)
} catch (error) {
	console.log(
		JSON.stringify(
			{
				ok: false,
				command: `ads-operator ${command}`,
				error: {
					message: error instanceof Error ? error.message : String(error),
					code: 'ADS_OPERATOR_ERROR',
				},
				fix: 'Check Course Builder env and supported ads operator commands.',
				next_actions: nextActions(),
			},
			null,
			2,
		),
	)
	process.exit(1)
}
