import { createHash } from 'node:crypto'
import { db } from '@/db'
import { googleAdsConversionUpload, purchases } from '@/db/schema'
import { and, desc, eq, gte, inArray, notInArray } from 'drizzle-orm'

const GOOGLE_CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid'] as const
const DEFAULT_CONVERSION_ACTION_RESOURCE_NAME =
	'customers/3867214797/conversionActions/7622646601'
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 5

type GoogleClickIdKey = (typeof GOOGLE_CLICK_ID_KEYS)[number]
type UploadStatus = 'dry-run' | 'uploaded' | 'validated' | 'failed' | 'skipped'

type AttributionSnapshot = {
	utm?: Record<string, string | undefined>
	clickIds?: Record<string, string | undefined>
	synthetic?: boolean
}

type PurchaseRow = {
	id: string
	createdAt: Date | string
	productId: string | null
	totalAmount: string | number | null
	status: string | null
	fields: unknown
}

export type PreparedGoogleAdsConversion = {
	purchaseId: string
	conversionActionResourceName: string
	clickIdType: GoogleClickIdKey
	clickIdValue: string
	clickIdHash: string
	conversionDateTime: string
	conversionValue: number
	currencyCode: 'USD'
	orderId: string
	idempotencyKey: string
	requestSummary: Record<string, unknown>
}

export type GoogleAdsConversionUploadConfig = {
	enabled: boolean
	validateOnly: boolean
	customerId: string
	loginCustomerId?: string
	developerToken?: string
	clientId?: string
	clientSecret?: string
	refreshToken?: string
	conversionActionResourceName: string
	retryDelayMs: number
	maxAttempts: number
}

export type GoogleAdsUploadClientResult = {
	status: 'uploaded' | 'validated' | 'failed'
	responseSummary: Record<string, unknown>
	lastError?: Record<string, unknown>
}

export type GoogleAdsUploadClient = {
	upload: (
		conversion: PreparedGoogleAdsConversion,
		config: GoogleAdsConversionUploadConfig,
	) => Promise<GoogleAdsUploadClientResult>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parseNumber = (value: unknown) => {
	const parsed = Number(value ?? 0)
	return Number.isFinite(parsed) ? parsed : 0
}

const sha256 = (value: string) =>
	createHash('sha256').update(value).digest('hex')

const isSyntheticClickId = (clickIds: Record<string, unknown> | undefined) =>
	Boolean(
		clickIds &&
		Object.values(clickIds).some(
			(value) => typeof value === 'string' && value.startsWith('TEST_'),
		),
	)

const parseAttribution = (fields: unknown): AttributionSnapshot | undefined => {
	if (!isRecord(fields)) return undefined
	const attribution = fields.attribution
	return isRecord(attribution)
		? (attribution as AttributionSnapshot)
		: undefined
}

export function selectGoogleClickId(
	attribution: AttributionSnapshot | undefined,
) {
	const clickIds = attribution?.clickIds
	if (!isRecord(clickIds)) return undefined
	if (attribution?.synthetic || isSyntheticClickId(clickIds)) return undefined

	for (const key of GOOGLE_CLICK_ID_KEYS) {
		const value = clickIds[key]
		if (typeof value === 'string' && value.trim().length > 0) {
			return { type: key, value: value.trim() }
		}
	}
	return undefined
}

export function formatGoogleAdsConversionDateTime(value: Date | string) {
	const date = value instanceof Date ? value : new Date(value)
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid conversion date: ${String(value)}`)
	}
	return date
		.toISOString()
		.replace('T', ' ')
		.replace(/\.\d{3}Z$/, '+00:00')
}

export function prepareGoogleAdsConversion(args: {
	purchase: PurchaseRow
	conversionActionResourceName: string
}):
	| { ok: true; conversion: PreparedGoogleAdsConversion }
	| { ok: false; reason: string } {
	const revenue = parseNumber(args.purchase.totalAmount)
	const validPaid =
		['Valid', 'Restricted'].includes(args.purchase.status ?? '') && revenue > 0
	if (!validPaid) return { ok: false, reason: 'invalid-or-non-paid' }

	const attribution = parseAttribution(args.purchase.fields)
	if (!attribution) return { ok: false, reason: 'missing-attribution' }

	const clickId = selectGoogleClickId(attribution)
	if (!clickId) return { ok: false, reason: 'missing-google-click-id' }

	const conversionDateTime = formatGoogleAdsConversionDateTime(
		args.purchase.createdAt,
	)
	const idempotencyKey = [
		'google-ads-click-conversion',
		args.purchase.id,
		args.conversionActionResourceName,
	].join(':')
	const requestSummary = {
		purchaseId: args.purchase.id,
		productId: args.purchase.productId,
		conversionActionResourceName: args.conversionActionResourceName,
		clickIdType: clickId.type,
		clickIdHash: sha256(clickId.value),
		conversionDateTime,
		conversionValue: revenue,
		currencyCode: 'USD',
		orderId: args.purchase.id,
		utm: {
			source: attribution.utm?.source,
			medium: attribution.utm?.medium,
			campaign: attribution.utm?.campaign,
			content: attribution.utm?.content,
		},
	}

	return {
		ok: true,
		conversion: {
			purchaseId: args.purchase.id,
			conversionActionResourceName: args.conversionActionResourceName,
			clickIdType: clickId.type,
			clickIdValue: clickId.value,
			clickIdHash: sha256(clickId.value),
			conversionDateTime,
			conversionValue: revenue,
			currencyCode: 'USD',
			orderId: args.purchase.id,
			idempotencyKey,
			requestSummary,
		},
	}
}

export function readGoogleAdsConversionUploadConfig(
	overrides: Partial<GoogleAdsConversionUploadConfig> = {},
): GoogleAdsConversionUploadConfig {
	return {
		enabled:
			overrides.enabled ??
			process.env.AIH_GOOGLE_ADS_CONVERSION_UPLOAD_ENABLED === 'true',
		validateOnly:
			overrides.validateOnly ??
			process.env.AIH_GOOGLE_ADS_CONVERSION_UPLOAD_VALIDATE_ONLY === 'true',
		customerId: (
			overrides.customerId ??
			process.env.GOOGLE_ADS_CUSTOMER_ID ??
			'3867214797'
		).replace(/-/g, ''),
		loginCustomerId: (
			overrides.loginCustomerId ?? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
		)?.replace(/-/g, ''),
		developerToken:
			overrides.developerToken ?? process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
		clientId: overrides.clientId ?? process.env.GOOGLE_ADS_CLIENT_ID,
		clientSecret:
			overrides.clientSecret ?? process.env.GOOGLE_ADS_CLIENT_SECRET,
		refreshToken:
			overrides.refreshToken ?? process.env.GOOGLE_ADS_REFRESH_TOKEN,
		conversionActionResourceName:
			overrides.conversionActionResourceName ??
			process.env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_RESOURCE_NAME ??
			DEFAULT_CONVERSION_ACTION_RESOURCE_NAME,
		retryDelayMs: overrides.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
		maxAttempts: overrides.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
	}
}

export function missingGoogleAdsConfig(
	config: GoogleAdsConversionUploadConfig,
) {
	return [
		['developerToken', config.developerToken],
		['clientId', config.clientId],
		['clientSecret', config.clientSecret],
		['refreshToken', config.refreshToken],
		['conversionActionResourceName', config.conversionActionResourceName],
	].flatMap(([key, value]) => (value ? [] : [key as string]))
}

let googleAdsAccessTokenCache:
	| { key: string; token: string; expiresAt: number }
	| undefined

async function googleAdsAccessToken(config: GoogleAdsConversionUploadConfig) {
	if (!config.clientId || !config.clientSecret || !config.refreshToken) {
		throw new Error('Google Ads OAuth config is missing')
	}
	const cacheKey = [
		config.clientId,
		config.refreshToken,
		config.loginCustomerId ?? '',
		config.customerId,
	].join(':')
	const now = Date.now()
	if (
		googleAdsAccessTokenCache?.key === cacheKey &&
		googleAdsAccessTokenCache.expiresAt > now + 60_000
	) {
		return googleAdsAccessTokenCache.token
	}
	const body = new URLSearchParams({
		client_id: config.clientId,
		client_secret: config.clientSecret,
		refresh_token: config.refreshToken,
		grant_type: 'refresh_token',
	})
	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		body,
	})
	const json = (await response.json()) as {
		access_token?: string
		expires_in?: number
		error?: string
	}
	if (!response.ok || !json.access_token) {
		throw new Error(json.error ?? 'Google OAuth token request failed')
	}
	googleAdsAccessTokenCache = {
		key: cacheKey,
		token: json.access_token,
		expiresAt: now + Number(json.expires_in ?? 3600) * 1000,
	}
	return json.access_token
}

function sanitizeGoogleAdsResponse(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return { rawType: typeof value }
	return {
		requestId: value.requestId,
		partialFailureError: value.partialFailureError,
		resultCount: Array.isArray(value.results) ? value.results.length : 0,
		jobId: value.jobId,
	}
}

export const googleAdsRestUploadClient: GoogleAdsUploadClient = {
	upload: async (conversion, config) => {
		if (!config.developerToken?.trim()) {
			throw new Error('Google Ads developer token is missing')
		}
		const accessToken = await googleAdsAccessToken(config)
		const body = {
			conversions: [
				{
					conversionAction: conversion.conversionActionResourceName,
					[conversion.clickIdType]: conversion.clickIdValue,
					conversionDateTime: conversion.conversionDateTime,
					conversionValue: conversion.conversionValue,
					currencyCode: conversion.currencyCode,
					orderId: conversion.orderId,
				},
			],
			partialFailure: true,
			validateOnly: config.validateOnly,
		}
		const headers = {
			Authorization: `Bearer ${accessToken}`,
			'developer-token': config.developerToken.trim(),
			...(config.loginCustomerId
				? { 'login-customer-id': config.loginCustomerId }
				: {}),
			'content-type': 'application/json',
		}
		const response = await fetch(
			`https://googleads.googleapis.com/v24/customers/${config.customerId}:uploadClickConversions`,
			{
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			},
		)
		const json = (await response.json()) as unknown
		const responseSummary = sanitizeGoogleAdsResponse(json)

		if (!response.ok) {
			return {
				status: 'failed',
				responseSummary,
				lastError: {
					kind: 'google-ads-http-error',
					status: response.status,
					responseSummary,
				},
			}
		}
		if (isRecord(json) && json.partialFailureError) {
			return {
				status: 'failed',
				responseSummary,
				lastError: {
					kind: 'google-ads-partial-failure',
					partialFailureError: json.partialFailureError,
				},
			}
		}
		return {
			status: config.validateOnly ? 'validated' : 'uploaded',
			responseSummary,
		}
	},
}

async function fetchCandidatePurchases(args: {
	database: typeof db
	purchaseId?: string
	productId?: string
	since?: Date | null
	limit: number
	excludeTerminalLedger: boolean
}) {
	const conditions = []
	if (args.excludeTerminalLedger) {
		const terminalLedgerRows = args.database
			.select({ purchaseId: googleAdsConversionUpload.purchaseId })
			.from(googleAdsConversionUpload)
			.where(
				inArray(googleAdsConversionUpload.status, ['uploaded', 'validated']),
			)
		conditions.push(notInArray(purchases.id, terminalLedgerRows))
	}
	if (args.purchaseId) conditions.push(eq(purchases.id, args.purchaseId))
	if (args.productId) conditions.push(eq(purchases.productId, args.productId))
	if (args.since) conditions.push(gte(purchases.createdAt, args.since))

	return args.database
		.select({
			id: purchases.id,
			createdAt: purchases.createdAt,
			productId: purchases.productId,
			totalAmount: purchases.totalAmount,
			status: purchases.status,
			fields: purchases.fields,
		})
		.from(purchases)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(purchases.createdAt))
		.limit(args.limit)
}

async function findLedger(database: typeof db, idempotencyKey: string) {
	const rows = await database
		.select()
		.from(googleAdsConversionUpload)
		.where(eq(googleAdsConversionUpload.idempotencyKey, idempotencyKey))
		.limit(1)
	return rows[0]
}

function canRetryLedger(args: {
	status: string
	attemptCount: number
	lastAttemptAt: Date | null
	config: GoogleAdsConversionUploadConfig
	now: Date
}) {
	if (['uploaded', 'validated'].includes(args.status)) return false
	if (args.attemptCount >= args.config.maxAttempts) return false
	if (!args.lastAttemptAt) return true
	return (
		args.now.getTime() - args.lastAttemptAt.getTime() >=
		args.config.retryDelayMs
	)
}

async function reserveLedger(args: {
	database: typeof db
	conversion: PreparedGoogleAdsConversion
	now: Date
}) {
	const values = {
		purchaseId: args.conversion.purchaseId,
		conversionActionResourceName: args.conversion.conversionActionResourceName,
		clickIdType: args.conversion.clickIdType,
		clickIdHash: args.conversion.clickIdHash,
		conversionDateTime: args.conversion.conversionDateTime,
		conversionValue: args.conversion.conversionValue.toFixed(2),
		currencyCode: args.conversion.currencyCode,
		orderId: args.conversion.orderId,
		status: 'pending',
		attemptCount: 0,
		idempotencyKey: args.conversion.idempotencyKey,
		requestSummary: args.conversion.requestSummary,
		createdAt: args.now,
		updatedAt: args.now,
	}
	try {
		await args.database.insert(googleAdsConversionUpload).values(values)
	} catch (error) {
		const existing = await findLedger(
			args.database,
			args.conversion.idempotencyKey,
		)
		if (existing) return existing
		throw error
	}
	const created = await findLedger(
		args.database,
		args.conversion.idempotencyKey,
	)
	if (!created)
		throw new Error('Google Ads conversion ledger reservation failed')
	return created
}

export async function processGoogleAdsConversionUploads(args: {
	database?: typeof db
	config?: GoogleAdsConversionUploadConfig
	uploadClient?: GoogleAdsUploadClient
	purchaseId?: string
	productId?: string
	since?: Date | null
	limit?: number
	dryRun?: boolean
	now?: Date
}) {
	const database = args.database ?? db
	const config = args.config ?? readGoogleAdsConversionUploadConfig()
	const uploadClient = args.uploadClient ?? googleAdsRestUploadClient
	const now = args.now ?? new Date()
	const dryRun = args.dryRun ?? true
	const rows = await fetchCandidatePurchases({
		database,
		purchaseId: args.purchaseId,
		productId: args.productId,
		since: args.since,
		limit: args.limit ?? 100,
		excludeTerminalLedger: !dryRun,
	})
	const missingConfig = missingGoogleAdsConfig(config)
	const summary = {
		mode: dryRun ? 'dry-run' : config.enabled ? 'upload' : 'disabled',
		checked: rows.length,
		eligible: 0,
		uploaded: 0,
		validated: 0,
		dryRunEligible: 0,
		skipped: 0,
		failed: 0,
		missingConfig,
		byReason: {} as Record<string, number>,
		byClickIdType: {} as Record<GoogleClickIdKey, number>,
		byResultStatus: {} as Record<UploadStatus, number>,
		privacy: 'aggregate-only-no-click-ids-no-emails-no-purchase-ids',
	}
	const countReason = (reason: string) => {
		summary.byReason[reason] = (summary.byReason[reason] ?? 0) + 1
	}
	const countResult = (status: UploadStatus) => {
		summary.byResultStatus[status] = (summary.byResultStatus[status] ?? 0) + 1
	}
	const countClickIdType = (type: GoogleClickIdKey) => {
		summary.byClickIdType[type] = (summary.byClickIdType[type] ?? 0) + 1
	}

	for (const row of rows) {
		const prepared = prepareGoogleAdsConversion({
			purchase: row,
			conversionActionResourceName: config.conversionActionResourceName,
		})
		if (!prepared.ok) {
			countReason(prepared.reason)
			summary.skipped += 1
			continue
		}
		summary.eligible += 1
		const conversion = prepared.conversion
		countClickIdType(conversion.clickIdType)

		if (dryRun) {
			summary.dryRunEligible += 1
			countResult('dry-run')
			continue
		}
		if (!config.enabled) {
			summary.skipped += 1
			countReason('upload-disabled')
			countResult('skipped')
			continue
		}
		if (missingConfig.length > 0) {
			summary.skipped += 1
			countReason('google-ads-config-missing')
			countResult('skipped')
			continue
		}

		const ledger = await reserveLedger({ database, conversion, now })
		if (
			!canRetryLedger({
				status: ledger.status,
				attemptCount: ledger.attemptCount,
				lastAttemptAt: ledger.lastAttemptAt,
				config,
				now,
			})
		) {
			summary.skipped += 1
			countReason(`ledger-${ledger.status}`)
			countResult('skipped')
			continue
		}

		await database
			.update(googleAdsConversionUpload)
			.set({
				status: 'pending',
				attemptCount: ledger.attemptCount + 1,
				lastAttemptAt: now,
				updatedAt: now,
			})
			.where(eq(googleAdsConversionUpload.id, ledger.id))

		let upload: GoogleAdsUploadClientResult
		try {
			upload = await uploadClient.upload(conversion, config)
		} catch (error) {
			const lastError = {
				kind: 'upload-client-threw',
				message: error instanceof Error ? error.message : String(error),
			}
			await database
				.update(googleAdsConversionUpload)
				.set({
					status: 'failed',
					responseSummary: null,
					lastError,
					uploadedAt: null,
					updatedAt: now,
				})
				.where(eq(googleAdsConversionUpload.id, ledger.id))
			summary.failed += 1
			countResult('failed')
			continue
		}

		const status: UploadStatus = upload.status
		await database
			.update(googleAdsConversionUpload)
			.set({
				status,
				responseSummary: upload.responseSummary,
				lastError: upload.lastError,
				uploadedAt:
					status === 'uploaded' || status === 'validated' ? now : null,
				updatedAt: now,
			})
			.where(eq(googleAdsConversionUpload.id, ledger.id))

		if (status === 'uploaded') summary.uploaded += 1
		else if (status === 'validated') summary.validated += 1
		else summary.failed += 1
		countResult(status)
	}

	return summary
}

export function sinceForGoogleAdsUploadRange(
	range: '24h' | '7d' | '30d' | '90d' | 'all',
) {
	if (range === 'all') return null
	const days = range === '24h' ? 1 : Number(range.replace('d', ''))
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}
