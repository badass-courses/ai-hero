import { createHash } from 'node:crypto'
import { db } from '@/db'
import {
	contact,
	contactState,
	googleAdsConversionUpload,
	providerIdentity,
	purchases,
	users,
} from '@/db/schema'
import type { OptInAttribution } from './subscriber-marketing/opt-in-attribution'
import { and, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm'

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
	kitSubscriberId?: string
	synthetic?: boolean
}

export type PurchaseRow = {
	id: string
	createdAt: Date | string
	productId: string | null
	totalAmount: string | number | null
	status: string | null
	fields: unknown
	buyerEmail?: string | null
}

export type PurchaseAttributionSource = 'checkout' | 'signup-gclid-fallback'

export type SignupGclidFallback = {
	clickIdValue: string
	capturedAt: string
	resolution: 'buyer-email' | 'kit-provider-identity'
}

export type GoogleAdsPurchaseFallbackResult =
	| { ok: true; fallback: SignupGclidFallback }
	| { ok: false; reason: string }

export type GoogleAdsPurchaseFallbackResolver = (
	purchase: PurchaseRow,
) => Promise<GoogleAdsPurchaseFallbackResult>

export type PreparedGoogleAdsConversion = {
	purchaseId: string
	conversionActionResourceName: string
	clickIdType: GoogleClickIdKey
	clickIdValue: string
	clickIdHash: string
	attributionSource: PurchaseAttributionSource
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

export type GoogleAdsUploadConversion = Omit<
	PreparedGoogleAdsConversion,
	'attributionSource'
> & {
	attributionSource?: PurchaseAttributionSource
}

export type GoogleAdsUploadClient = {
	upload: (
		conversion: GoogleAdsUploadConversion,
		config: GoogleAdsConversionUploadConfig,
	) => Promise<GoogleAdsUploadClientResult>
}

type PurchaseLedgerResult =
	| { status: 'reserved'; attemptCount: number }
	| { status: 'idempotent-noop' }

export type GoogleAdsPurchaseConversionLedger = {
	reserve: (args: {
		conversion: PreparedGoogleAdsConversion
		config: GoogleAdsConversionUploadConfig
		now: Date
	}) => Promise<PurchaseLedgerResult>
	recordResult: (args: {
		conversion: PreparedGoogleAdsConversion
		attemptCount: number
		result: GoogleAdsUploadClientResult
		now: Date
	}) => Promise<void>
	recordThrownError: (args: {
		conversion: PreparedGoogleAdsConversion
		attemptCount: number
		error: unknown
		now: Date
	}) => Promise<void>
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

export function isClickWithinGoogleUploadWindow(args: {
	clickAt: Date | string
	conversionAt: Date | string
	windowDays?: number
}) {
	const clickAt = new Date(args.clickAt)
	const conversionAt = new Date(args.conversionAt)
	if (Number.isNaN(clickAt.getTime()) || Number.isNaN(conversionAt.getTime())) {
		return false
	}
	const ageMs = conversionAt.getTime() - clickAt.getTime()
	return ageMs >= 0 && ageMs <= (args.windowDays ?? 90) * 24 * 60 * 60 * 1000
}

export function prepareGoogleAdsConversion(args: {
	purchase: PurchaseRow
	conversionActionResourceName: string
	fallback?: SignupGclidFallback
}):
	| { ok: true; conversion: PreparedGoogleAdsConversion }
	| { ok: false; reason: string } {
	const revenue = parseNumber(args.purchase.totalAmount)
	const validPaid =
		['Valid', 'Restricted'].includes(args.purchase.status ?? '') && revenue > 0
	if (!validPaid) return { ok: false, reason: 'invalid-or-non-paid' }

	const attribution = parseAttribution(args.purchase.fields)
	if (
		attribution?.synthetic ||
		isSyntheticClickId(attribution?.clickIds as Record<string, unknown> | undefined)
	) {
		return { ok: false, reason: 'synthetic-google-click-id' }
	}
	const checkoutClickId = selectGoogleClickId(attribution)
	const fallbackValue = args.fallback?.clickIdValue.trim()
	if (!checkoutClickId && !fallbackValue) {
		return { ok: false, reason: 'missing-google-click-id' }
	}
	if (
		!checkoutClickId &&
		(fallbackValue?.startsWith('TEST_') ||
			!isClickWithinGoogleUploadWindow({
				clickAt: args.fallback!.capturedAt,
				conversionAt: args.purchase.createdAt,
			}))
	) {
		return { ok: false, reason: 'signup-gclid-outside-90-day-window' }
	}
	const clickId = checkoutClickId ?? {
		type: 'gclid' as const,
		value: fallbackValue!,
	}
	const attributionSource: PurchaseAttributionSource = checkoutClickId
		? 'checkout'
		: 'signup-gclid-fallback'

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
		attributionSource,
		...(args.fallback ? { fallbackResolution: args.fallback.resolution } : {}),
		conversionDateTime,
		conversionValue: revenue,
		currencyCode: 'USD',
		orderId: args.purchase.id,
		utm: {
			source: attribution?.utm?.source,
			medium: attribution?.utm?.medium,
			campaign: attribution?.utm?.campaign,
			content: attribution?.utm?.content,
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
			attributionSource,
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
	conversionActionResourceName: string
	purchaseId?: string
	productId?: string
	since?: Date | null
	limit: number
	excludeTerminalLedger: boolean
}) {
	const conditions = [
		inArray(purchases.status, ['Valid', 'Restricted']),
		sql`${purchases.totalAmount} > 0`,
	]
	if (args.excludeTerminalLedger) {
		const terminalLedgerRows = args.database
			.select({ purchaseId: googleAdsConversionUpload.purchaseId })
			.from(googleAdsConversionUpload)
			.where(
				and(
					inArray(googleAdsConversionUpload.status, ['uploaded']),
					eq(
						googleAdsConversionUpload.conversionActionResourceName,
						args.conversionActionResourceName,
					),
				),
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
			buyerEmail: users.email,
		})
		.from(purchases)
		.leftJoin(users, eq(purchases.userId, users.id))
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(purchases.createdAt))
		.limit(args.limit)
}

function normalizeKitSubscriberId(value: unknown) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	if (!trimmed) return undefined
	try {
		const parsed = JSON.parse(trimmed) as unknown
		if (typeof parsed === 'string' || typeof parsed === 'number') {
			return String(parsed).trim() || undefined
		}
	} catch {
		// URL-param cookies are plain strings; full subscriber cookies are JSON.
	}
	return trimmed
}

function kitSubscriberIdFromPurchase(purchase: PurchaseRow) {
	return normalizeKitSubscriberId(
		parseAttribution(purchase.fields)?.kitSubscriberId,
	)
}

export function createGoogleAdsPurchaseFallbackResolver(
	database: typeof db = db,
): GoogleAdsPurchaseFallbackResolver {
	return async (purchase) => {
		const normalizedEmail = purchase.buyerEmail?.trim().toLowerCase()
		const emailMatches = normalizedEmail
			? await database
					.select({ contactId: contact.id })
					.from(contact)
					.where(eq(contact.email, normalizedEmail))
					.limit(2)
			: []

		let contactId =
			emailMatches.length === 1 ? emailMatches[0]!.contactId : undefined
		let resolution: SignupGclidFallback['resolution'] | undefined = contactId
			? 'buyer-email'
			: undefined
		const kitSubscriberId = kitSubscriberIdFromPurchase(purchase)
		if (!contactId && kitSubscriberId) {
			const identities = await database
				.select({ contactId: providerIdentity.contactId })
				.from(providerIdentity)
				.where(
					and(
						eq(providerIdentity.provider, 'kit'),
						eq(providerIdentity.externalId, kitSubscriberId),
					),
				)
				.limit(1)
			contactId = identities[0]?.contactId
			if (contactId) resolution = 'kit-provider-identity'
		}
		if (!contactId) {
			return {
				ok: false,
				reason:
					emailMatches.length > 1
						? 'fallback-ambiguous-buyer-email'
						: 'fallback-contact-not-found',
			}
		}

		const states = await database
			.select({ attribution: contactState.optInAttribution })
			.from(contactState)
			.where(eq(contactState.contactId, contactId))
			.limit(1)
		const attribution = states[0]?.attribution as OptInAttribution | null
		const gclid = attribution?.gclid?.trim()
		if (!attribution?.subscribedAt || !gclid || gclid.startsWith('TEST_')) {
			return { ok: false, reason: 'fallback-real-gclid-signup-not-found' }
		}
		if (
			!isClickWithinGoogleUploadWindow({
				clickAt: attribution.capturedAt,
				conversionAt: purchase.createdAt,
			})
		) {
			return {
				ok: false,
				reason: 'signup-gclid-outside-90-day-window',
			}
		}
		return {
			ok: true,
			fallback: {
				clickIdValue: gclid,
				capturedAt: attribution.capturedAt,
				resolution: resolution!,
			},
		}
	}
}

function affectedRows(result: unknown) {
	if (!result || typeof result !== 'object') return 0
	const record = result as Record<string, unknown>
	if (typeof record.rowsAffected === 'number') return record.rowsAffected
	if (Array.isArray(result)) {
		const first = result[0]
		if (first && typeof first === 'object') {
			const count = (first as Record<string, unknown>).affectedRows
			if (typeof count === 'number') return count
		}
	}
	return 0
}

export function createGoogleAdsPurchaseConversionLedger(
	database: typeof db = db,
): GoogleAdsPurchaseConversionLedger {
	return {
		async reserve({ conversion, config, now }) {
			const existing = await database
				.select({
					status: googleAdsConversionUpload.status,
					attemptCount: googleAdsConversionUpload.attemptCount,
					lastAttemptAt: googleAdsConversionUpload.lastAttemptAt,
				})
				.from(googleAdsConversionUpload)
				.where(
					eq(
						googleAdsConversionUpload.idempotencyKey,
						conversion.idempotencyKey,
					),
				)
				.limit(1)
			const row = existing[0]
			if (row) {
				const uploadValidated =
					row.status === 'validated' && !config.validateOnly
				const retryable =
					['failed', 'pending', 'processing'].includes(row.status) &&
					row.attemptCount < config.maxAttempts &&
					(!row.lastAttemptAt ||
						now.getTime() - row.lastAttemptAt.getTime() >= config.retryDelayMs)
				if (!uploadValidated && !retryable) {
					return { status: 'idempotent-noop' }
				}
				const reservation = await database
					.update(googleAdsConversionUpload)
					.set({
						status: 'processing',
						attemptCount: sql`${googleAdsConversionUpload.attemptCount} + 1`,
						attributionSource: conversion.attributionSource,
						requestSummary: conversion.requestSummary,
						lastAttemptAt: now,
						updatedAt: now,
					})
					.where(
						and(
							eq(
								googleAdsConversionUpload.idempotencyKey,
								conversion.idempotencyKey,
							),
							eq(googleAdsConversionUpload.status, row.status),
							eq(googleAdsConversionUpload.attemptCount, row.attemptCount),
						),
					)
				return affectedRows(reservation) > 0
					? { status: 'reserved', attemptCount: row.attemptCount + 1 }
					: { status: 'idempotent-noop' }
			}

			try {
				await database.insert(googleAdsConversionUpload).values({
					purchaseId: conversion.purchaseId,
					conversionActionResourceName: conversion.conversionActionResourceName,
					clickIdType: conversion.clickIdType,
					clickIdHash: conversion.clickIdHash,
					attributionSource: conversion.attributionSource,
					conversionDateTime: conversion.conversionDateTime,
					conversionValue: conversion.conversionValue.toFixed(2),
					currencyCode: conversion.currencyCode,
					orderId: conversion.orderId,
					status: 'processing',
					attemptCount: 1,
					idempotencyKey: conversion.idempotencyKey,
					requestSummary: conversion.requestSummary,
					lastAttemptAt: now,
					createdAt: now,
					updatedAt: now,
				})
				return { status: 'reserved', attemptCount: 1 }
			} catch (error) {
				const concurrent = await database
					.select({ status: googleAdsConversionUpload.status })
					.from(googleAdsConversionUpload)
					.where(
						eq(
							googleAdsConversionUpload.idempotencyKey,
							conversion.idempotencyKey,
						),
					)
					.limit(1)
				if (concurrent[0]) return { status: 'idempotent-noop' }
				throw error
			}
		},
		async recordResult({ conversion, attemptCount, result, now }) {
			await database
				.update(googleAdsConversionUpload)
				.set({
					status: result.status,
					responseSummary: result.responseSummary,
					lastError: result.lastError,
					uploadedAt: result.status === 'uploaded' ? now : null,
					updatedAt: now,
				})
				.where(
					and(
						eq(
							googleAdsConversionUpload.idempotencyKey,
							conversion.idempotencyKey,
						),
						eq(googleAdsConversionUpload.status, 'processing'),
						eq(googleAdsConversionUpload.attemptCount, attemptCount),
					),
				)
		},
		async recordThrownError({ conversion, attemptCount, error, now }) {
			await database
				.update(googleAdsConversionUpload)
				.set({
					status: 'failed',
					responseSummary: null,
					lastError: {
						kind: 'upload-client-threw',
						message: error instanceof Error ? error.message : String(error),
					},
					uploadedAt: null,
					updatedAt: now,
				})
				.where(
					and(
						eq(
							googleAdsConversionUpload.idempotencyKey,
							conversion.idempotencyKey,
						),
						eq(googleAdsConversionUpload.status, 'processing'),
						eq(googleAdsConversionUpload.attemptCount, attemptCount),
					),
				)
		},
	}
}

export async function processGoogleAdsConversionUploads(args: {
	database?: typeof db
	config?: GoogleAdsConversionUploadConfig
	uploadClient?: GoogleAdsUploadClient
	ledger?: GoogleAdsPurchaseConversionLedger
	fallbackResolver?: GoogleAdsPurchaseFallbackResolver
	candidates?: PurchaseRow[]
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
	const rows =
		args.candidates ??
		(await fetchCandidatePurchases({
			database,
			conversionActionResourceName: config.conversionActionResourceName,
			purchaseId: args.purchaseId,
			productId: args.productId,
			since: args.since,
			limit: args.limit ?? 100,
			excludeTerminalLedger: !dryRun,
		}))
	const fallbackResolver =
		args.fallbackResolver ?? createGoogleAdsPurchaseFallbackResolver(database)
	const ledger =
		args.ledger ?? createGoogleAdsPurchaseConversionLedger(database)
	const missingConfig = missingGoogleAdsConfig(config)
	const summary = {
		mode: dryRun ? 'dry-run' : config.enabled ? 'upload' : 'disabled',
		checked: rows.length,
		candidates: rows.length,
		eligible: 0,
		fallbackCandidates: 0,
		fallbackResolved: 0,
		uploaded: 0,
		validated: 0,
		dryRunEligible: 0,
		skipped: 0,
		failed: 0,
		missingConfig,
		byReason: {} as Record<string, number>,
		byClickIdType: {} as Record<GoogleClickIdKey, number>,
		byAttributionSource: {} as Record<PurchaseAttributionSource, number>,
		byFallbackResolution: {} as Record<
			SignupGclidFallback['resolution'],
			number
		>,
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
	const countAttributionSource = (source: PurchaseAttributionSource) => {
		summary.byAttributionSource[source] =
			(summary.byAttributionSource[source] ?? 0) + 1
	}

	for (const row of rows) {
		let prepared = prepareGoogleAdsConversion({
			purchase: row,
			conversionActionResourceName: config.conversionActionResourceName,
		})
		if (!prepared.ok && prepared.reason === 'missing-google-click-id') {
			summary.fallbackCandidates += 1
			const resolved = await fallbackResolver(row)
			if (!resolved.ok) {
				countReason(resolved.reason)
				summary.skipped += 1
				continue
			}
			summary.fallbackResolved += 1
			summary.byFallbackResolution[resolved.fallback.resolution] =
				(summary.byFallbackResolution[resolved.fallback.resolution] ?? 0) + 1
			prepared = prepareGoogleAdsConversion({
				purchase: row,
				conversionActionResourceName: config.conversionActionResourceName,
				fallback: resolved.fallback,
			})
		}
		if (!prepared.ok) {
			countReason(prepared.reason)
			summary.skipped += 1
			continue
		}
		summary.eligible += 1
		const conversion = prepared.conversion
		countClickIdType(conversion.clickIdType)
		countAttributionSource(conversion.attributionSource)

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

		const reservation = await ledger.reserve({ conversion, config, now })
		if (reservation.status === 'idempotent-noop') {
			summary.skipped += 1
			countReason('ledger-idempotent-noop')
			countResult('skipped')
			continue
		}

		let upload: GoogleAdsUploadClientResult
		try {
			upload = await uploadClient.upload(conversion, config)
		} catch (error) {
			await ledger.recordThrownError({
				conversion,
				attemptCount: reservation.attemptCount,
				error,
				now,
			})
			summary.failed += 1
			countResult('failed')
			continue
		}

		const status: UploadStatus = upload.status
		await ledger.recordResult({
			conversion,
			attemptCount: reservation.attemptCount,
			result: upload,
			now,
		})

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
