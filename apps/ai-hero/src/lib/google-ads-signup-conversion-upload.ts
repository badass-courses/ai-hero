import { createHash } from 'node:crypto'
import { db } from '@/db'
import {
	contact,
	contactState,
	googleAdsSignupConversionUpload,
} from '@/db/schema'
import {
	formatGoogleAdsConversionDateTime,
	googleAdsRestUploadClient,
	missingGoogleAdsConfig,
	readGoogleAdsConversionUploadConfig,
	type GoogleAdsConversionUploadConfig,
	type GoogleAdsUploadClient,
	type GoogleAdsUploadClientResult,
} from './google-ads-conversion-upload'
import type { OptInAttribution } from './subscriber-marketing/opt-in-attribution'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'

export type SignupConversionCandidate = {
	contactId: string
	occurredAt: string
	attribution: OptInAttribution
}

export type PreparedSignupConversion = {
	contactId: string
	conversionActionResourceName: string
	clickIdType: 'gclid' | 'gbraid' | 'wbraid'
	clickIdValue: string
	clickIdHash: string
	conversionDateTime: string
	conversionValue: 0
	currencyCode: 'USD'
	orderId: string
	idempotencyKey: string
	requestSummary: Record<string, unknown>
}

type SignupLedgerResult = 'reserved' | 'idempotent-noop'

export type SignupConversionLedger = {
	reserve: (args: {
		conversion: PreparedSignupConversion
		retryFailed: boolean
		uploadValidated: boolean
		now: Date
	}) => Promise<SignupLedgerResult>
	recordResult: (args: {
		conversion: PreparedSignupConversion
		result: GoogleAdsUploadClientResult
		now: Date
	}) => Promise<void>
	recordThrownError: (args: {
		conversion: PreparedSignupConversion
		error: unknown
		now: Date
	}) => Promise<void>
}

export function prepareGoogleAdsSignupConversion(args: {
	candidate: SignupConversionCandidate
	conversionActionResourceName?: string
}) {
	const resource = args.conversionActionResourceName?.trim()
	if (!resource) {
		return {
			ok: false as const,
			reason: 'missing-conversion-action-resource',
		}
	}
	const values = [
		['gclid', args.candidate.attribution.gclid],
		['gbraid', args.candidate.attribution.gbraid],
		['wbraid', args.candidate.attribution.wbraid],
	] as const
	if (values.some(([, value]) => value?.startsWith('TEST_'))) {
		return { ok: false as const, reason: 'synthetic-click-id' }
	}
	const selected = values.find(([, value]) => value?.trim())
	if (!selected) {
		return { ok: false as const, reason: 'missing-google-click-id' }
	}
	const [clickIdType, clickIdValue] = selected as [
		typeof selected[0],
		string,
	]
	const clickIdHash = createHash('sha256').update(clickIdValue).digest('hex')
	const idempotencyKey = `google-ads-signup:${args.candidate.contactId}:${resource}`
	const conversionDateTime = formatGoogleAdsConversionDateTime(
		args.candidate.occurredAt,
	)
	const orderId = createHash('sha256')
		.update(idempotencyKey)
		.digest('hex')
		.slice(0, 32)
	const requestSummary = {
		contactId: args.candidate.contactId,
		conversionActionResourceName: resource,
		clickIdType,
		clickIdHash,
		conversionDateTime,
		conversionValue: 0,
		currencyCode: 'USD',
		orderId,
	}
	return {
		ok: true as const,
		conversion: {
			contactId: args.candidate.contactId,
			conversionActionResourceName: resource,
			clickIdType,
			clickIdValue,
			clickIdHash,
			conversionDateTime,
			conversionValue: 0 as const,
			currencyCode: 'USD' as const,
			orderId,
			idempotencyKey,
			requestSummary,
		},
	}
}

export function buildSignupConversionPreview(
	candidates: SignupConversionCandidate[],
) {
	const rows = candidates.flatMap((candidate) => {
		const values = [
			['gclid', candidate.attribution.gclid],
			['gbraid', candidate.attribution.gbraid],
			['wbraid', candidate.attribution.wbraid],
		] as const
		const selected = values.find(([, value]) => value?.trim())
		if (!selected) return []
		return [
			{
				clickIdType: selected[0],
				synthetic: selected[1]!.startsWith('TEST_'),
				conversionTime:
					candidate.attribution.subscribedAt ?? candidate.occurredAt,
			},
		]
	})
	return {
		rows,
		counts: {
			scanned: candidates.length,
			withClickEvidence: rows.length,
			synthetic: rows.filter((row) => row.synthetic).length,
			real: rows.filter((row) => !row.synthetic).length,
		},
		privacy: 'aggregate-preview-no-click-ids-no-emails-no-contact-ids' as const,
	}
}

export function prepareSignupConversionBatch(args: {
	candidates: SignupConversionCandidate[]
	conversionActionResourceName?: string
}) {
	const prepared: PreparedSignupConversion[] = []
	const excluded: Record<string, number> = {}
	for (const candidate of args.candidates) {
		const result = prepareGoogleAdsSignupConversion({
			candidate,
			conversionActionResourceName: args.conversionActionResourceName,
		})
		if (result.ok) prepared.push(result.conversion)
		else excluded[result.reason] = (excluded[result.reason] ?? 0) + 1
	}
	return {
		prepared,
		counts: {
			scanned: args.candidates.length,
			eligible: prepared.length,
			excluded,
		},
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

export function createGoogleAdsSignupConversionLedger(
	database: typeof db = db,
): SignupConversionLedger {
	return {
		async reserve({ conversion, retryFailed, uploadValidated, now }) {
			const existing = await database
				.select({ status: googleAdsSignupConversionUpload.status })
				.from(googleAdsSignupConversionUpload)
				.where(
					eq(
						googleAdsSignupConversionUpload.idempotencyKey,
						conversion.idempotencyKey,
					),
				)
				.limit(1)
			const status = existing[0]?.status
			if (status) {
				const retryable =
					(status === 'failed' && retryFailed) ||
					(status === 'validated' && uploadValidated)
				if (!retryable) return 'idempotent-noop'
				const reservation = await database
					.update(googleAdsSignupConversionUpload)
					.set({
						status: 'processing',
						attemptCount: sql`${googleAdsSignupConversionUpload.attemptCount} + 1`,
						updatedAt: now,
					})
					.where(
						and(
							eq(
								googleAdsSignupConversionUpload.idempotencyKey,
								conversion.idempotencyKey,
							),
							eq(googleAdsSignupConversionUpload.status, status),
						),
					)
				return affectedRows(reservation) > 0
					? 'reserved'
					: 'idempotent-noop'
			}
			try {
				await database.insert(googleAdsSignupConversionUpload).values({
					contactId: conversion.contactId,
					conversionActionResourceName:
						conversion.conversionActionResourceName,
					clickIdType: conversion.clickIdType,
					clickIdHash: conversion.clickIdHash,
					conversionDateTime: conversion.conversionDateTime,
					status: 'processing',
					attemptCount: 1,
					idempotencyKey: conversion.idempotencyKey,
					requestSummary: conversion.requestSummary,
					createdAt: now,
					updatedAt: now,
				})
				return 'reserved'
			} catch (error) {
				// The unique idempotency key turns concurrent cron attempts into a no-op.
				const concurrent = await database
					.select({ status: googleAdsSignupConversionUpload.status })
					.from(googleAdsSignupConversionUpload)
					.where(
						eq(
							googleAdsSignupConversionUpload.idempotencyKey,
							conversion.idempotencyKey,
						),
					)
					.limit(1)
				if (concurrent[0]) return 'idempotent-noop'
				throw error
			}
		},
		async recordResult({ conversion, result, now }) {
			await database
				.update(googleAdsSignupConversionUpload)
				.set({
					status: result.status,
					responseSummary: { ...result },
					updatedAt: now,
				})
				.where(
					eq(
						googleAdsSignupConversionUpload.idempotencyKey,
						conversion.idempotencyKey,
					),
				)
		},
		async recordThrownError({ conversion, error, now }) {
			await database
				.update(googleAdsSignupConversionUpload)
				.set({
					status: 'failed',
					responseSummary: {
						error: error instanceof Error ? error.message : String(error),
					},
					updatedAt: now,
				})
				.where(
					eq(
						googleAdsSignupConversionUpload.idempotencyKey,
						conversion.idempotencyKey,
					),
				)
		},
	}
}

export async function fetchGoogleAdsSignupConversionCandidates(args: {
	database?: typeof db
	conversionActionResourceName?: string
	since?: Date | null
	limit?: number
	excludeExisting?: boolean
	retryFailed?: boolean
	uploadValidated?: boolean
}) {
	const database = args.database ?? db
	const subscribedAt = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contactState.optInAttribution}, '$.subscribedAt'))`
	const gclid = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contactState.optInAttribution}, '$.gclid'))`
	const gbraid = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contactState.optInAttribution}, '$.gbraid'))`
	const wbraid = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contactState.optInAttribution}, '$.wbraid'))`
	const rows = await database
		.select({
			contactId: contact.id,
			attribution: contactState.optInAttribution,
		})
		.from(contactState)
		.innerJoin(contact, eq(contact.id, contactState.contactId))
		.leftJoin(
			googleAdsSignupConversionUpload,
			and(
				eq(googleAdsSignupConversionUpload.contactId, contact.id),
				eq(
					googleAdsSignupConversionUpload.conversionActionResourceName,
					args.conversionActionResourceName ?? '',
				),
			),
		)
		.where(
			and(
				sql`${subscribedAt} IS NOT NULL`,
				sql`COALESCE(NULLIF(TRIM(${gclid}), ''), NULLIF(TRIM(${gbraid}), ''), NULLIF(TRIM(${wbraid}), '')) IS NOT NULL`,
				sql`COALESCE(LEFT(${gclid}, 5), '') <> 'TEST_'`,
				sql`COALESCE(LEFT(${gbraid}, 5), '') <> 'TEST_'`,
				sql`COALESCE(LEFT(${wbraid}, 5), '') <> 'TEST_'`,
				args.since
					? sql`${subscribedAt} >= ${args.since.toISOString()}`
					: undefined,
				args.excludeExisting
					? args.retryFailed && args.uploadValidated
						? or(
								isNull(googleAdsSignupConversionUpload.id),
								inArray(googleAdsSignupConversionUpload.status, [
									'failed',
									'validated',
								]),
							)
						: args.retryFailed
							? or(
									isNull(googleAdsSignupConversionUpload.id),
									eq(googleAdsSignupConversionUpload.status, 'failed'),
								)
							: args.uploadValidated
								? or(
										isNull(googleAdsSignupConversionUpload.id),
										eq(
											googleAdsSignupConversionUpload.status,
											'validated',
										),
									)
								: isNull(googleAdsSignupConversionUpload.id)
					: undefined,
			),
		)
		.orderBy(desc(subscribedAt))
		.limit(args.limit ?? 100)
	return rows.map((row) => {
		const attribution = row.attribution as OptInAttribution
		return {
			contactId: row.contactId,
			occurredAt: attribution.subscribedAt!,
			attribution,
		}
	})
}

export async function processPreparedGoogleAdsSignupConversions(args: {
	candidates: SignupConversionCandidate[]
	conversionActionResourceName?: string
	config: GoogleAdsConversionUploadConfig
	uploadClient?: GoogleAdsUploadClient
	ledger: SignupConversionLedger
	dryRun?: boolean
	retryFailed?: boolean
	now?: Date
}) {
	const batch = prepareSignupConversionBatch({
		candidates: args.candidates,
		conversionActionResourceName: args.conversionActionResourceName,
	})
	const dryRun = args.dryRun ?? true
	const missingConfig = missingGoogleAdsConfig(args.config)
	const summary = {
		mode: dryRun ? ('dry-run' as const) : ('upload' as const),
		...batch.counts,
		dryRunEligible: 0,
		uploaded: 0,
		validated: 0,
		idempotentNoop: 0,
		skipped: 0,
		failed: 0,
		missingConfig,
		privacy: 'aggregate-only-no-click-ids-no-emails-no-contact-ids' as const,
	}

	if (dryRun || !args.config.enabled) {
		summary.dryRunEligible = batch.prepared.length
		return summary
	}
	if (missingConfig.length > 0) {
		summary.skipped = batch.prepared.length
		return summary
	}

	const uploadClient = args.uploadClient ?? googleAdsRestUploadClient
	const now = args.now ?? new Date()
	for (const conversion of batch.prepared) {
		const reservation = await args.ledger.reserve({
			conversion,
			retryFailed: args.retryFailed ?? false,
			uploadValidated: !args.config.validateOnly,
			now,
		})
		if (reservation === 'idempotent-noop') {
			summary.idempotentNoop += 1
			continue
		}
		try {
			const result = await uploadClient.upload(
				{ ...conversion, purchaseId: conversion.contactId },
				args.config,
			)
			await args.ledger.recordResult({ conversion, result, now })
			if (result.status === 'uploaded') summary.uploaded += 1
			else if (result.status === 'validated') summary.validated += 1
			else summary.failed += 1
		} catch (error) {
			await args.ledger.recordThrownError({ conversion, error, now })
			summary.failed += 1
		}
	}
	return summary
}

export async function processGoogleAdsSignupConversionUploads(args: {
	database?: typeof db
	config?: GoogleAdsConversionUploadConfig
	uploadClient?: GoogleAdsUploadClient
	ledger?: SignupConversionLedger
	candidates?: SignupConversionCandidate[]
	conversionActionResourceName?: string
	since?: Date | null
	limit?: number
	dryRun?: boolean
	retryFailed?: boolean
	includePreviewRows?: boolean
	now?: Date
}) {
	const database = args.database ?? db
	const actionResource = args.conversionActionResourceName?.trim()
	const dryRun = args.dryRun ?? true
	const config =
		args.config ??
		readGoogleAdsConversionUploadConfig({
			conversionActionResourceName: actionResource ?? '',
		})
	const candidates =
		args.candidates ??
		(await fetchGoogleAdsSignupConversionCandidates({
			database,
			conversionActionResourceName: actionResource,
			since: args.since,
			limit: args.limit,
			excludeExisting: !dryRun,
			retryFailed: args.retryFailed,
			uploadValidated: !config.validateOnly,
		}))
	const preview = buildSignupConversionPreview(candidates)
	const result = await processPreparedGoogleAdsSignupConversions({
		candidates,
		conversionActionResourceName: actionResource,
		config,
		uploadClient: args.uploadClient,
		ledger: args.ledger ?? createGoogleAdsSignupConversionLedger(database),
		dryRun,
		retryFailed: args.retryFailed,
		now: args.now,
	})
	return {
		...result,
		preview: preview.counts,
		...(args.includePreviewRows ? { previewRows: preview.rows } : {}),
	}
}
