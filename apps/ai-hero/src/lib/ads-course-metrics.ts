import { db } from '@/db'
import {
	contact,
	contactEvent,
	googleAdsSignupConversionUpload,
	sideEffectIntent,
} from '@/db/schema'
import { funnelMetricsWindow, type FunnelMetricsRange } from '@/lib/ads-metrics-window'
import { excludeLearnerFlowCanary } from '@/lib/subscriber-marketing/learner-flow-canary-exclusion'
import { readGoogleAdsConversionUploadConfig } from '@/lib/google-ads-conversion-upload'
import { and, count, countDistinct, eq, gte, sql } from 'drizzle-orm'

export type AdsMetricsRange = 'today' | 'yesterday' | '7d' | '30d'

const CAMPAIGN_IDS: Record<string, readonly string[]> = {
	'email-course': ['24027782592'],
}

function googleDateClause(range: AdsMetricsRange) {
	if (range === 'today') return 'TODAY'
	if (range === 'yesterday') return 'YESTERDAY'
	if (range === '7d') return 'LAST_7_DAYS'
	return 'LAST_30_DAYS'
}

function hasAttribution(value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const attribution = value as Record<string, unknown>
	return Boolean(
		attribution.utmSource ||
			attribution.utmMedium ||
			attribution.utmCampaign ||
			attribution.gclid ||
			attribution.gbraid ||
			attribution.wbraid,
	)
}

function inWindow(value: Date, start: Date, end: Date) {
	return value >= start && value < end
}

export async function getAdsCourseFunnelMetrics(options: {
	range?: FunnelMetricsRange
	now?: Date
} = {}) {
	const now = options.now ?? new Date()
	const range = options.range ?? 'today'
	const window = funnelMetricsWindow(range, now)
	const { start, end } = window
	const signupWhere = and(
		eq(contactEvent.eventType, 'skills-newsletter.subscribed'),
		excludeLearnerFlowCanary({ contactId: contactEvent.contactId }),
	)
	const emailResourceId = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${sideEffectIntent.metadata}, '$.emailResourceId'))`
	const emailIntentWhere = and(
		eq(sideEffectIntent.type, 'send-value-path-email'),
		sql`JSON_UNQUOTE(JSON_EXTRACT(${sideEffectIntent.metadata}, '$.valuePathSlug')) IN ('ai-hero-skills-workflow', 'ai-hero-skills-team-workflow')`,
		excludeLearnerFlowCanary({ contactId: sideEffectIntent.contactId }),
	)
	const countRows = async (where: any, source: { table: any; column: any }) => {
		const [totalRow] = await db.select({ value: count() }).from(source.table).where(where)
		const rangeWhere = and(where, gte(source.column, start), sql`${source.column} < ${end}`)
		const [rangeRow] = await db.select({ value: count() }).from(source.table).where(rangeWhere)
		return { range: Number(rangeRow?.value ?? 0), total: Number(totalRow?.value ?? 0) }
	}
	const countDistinctRows = async (where: any, source: { table: any; column: any; identity: any }) => {
		const [totalRow] = await db.select({ value: countDistinct(source.identity) }).from(source.table).where(where)
		const [rangeRow] = await db
			.select({ value: countDistinct(source.identity) })
			.from(source.table)
			.where(and(where, gte(source.column, start), sql`${source.column} < ${end}`))
		return { range: Number(rangeRow?.value ?? 0), total: Number(totalRow?.value ?? 0) }
	}
	const signups = await countRows(signupWhere, { table: contactEvent, column: contactEvent.occurredAt })
	const uniqueLearners = await countDistinctRows(signupWhere, {
		table: contactEvent,
		column: contactEvent.occurredAt,
		identity: contactEvent.contactId,
	})
	const contacts = await countRows(
		and(
			sql`${contact.id} IN (SELECT DISTINCT contactId FROM AI_ContactEvent WHERE eventType = 'skills-newsletter.subscribed')`,
			excludeLearnerFlowCanary({ email: contact.email }),
		),
		{ table: contact, column: contact.createdAt },
	)
	const emailZero = await countRows(
		and(emailIntentWhere, sql`${emailResourceId} LIKE '%email-0'`),
		{ table: sideEffectIntent, column: sideEffectIntent.createdAt },
	)
	const sent = await countRows(
		and(emailIntentWhere, sql`${emailResourceId} LIKE '%email-0'`, eq(sideEffectIntent.status, 'completed')),
		{ table: sideEffectIntent, column: sideEffectIntent.createdAt },
	)
	const allSent = await countRows(and(emailIntentWhere, eq(sideEffectIntent.status, 'completed')), { table: sideEffectIntent, column: sideEffectIntent.createdAt })
	const midPath = await countRows(
		and(emailIntentWhere, sql`${emailResourceId} NOT LIKE '%email-0'`, sql`${emailResourceId} NOT LIKE '%email-7'`),
		{ table: sideEffectIntent, column: sideEffectIntent.createdAt },
	)
	const terminal = await countRows(
		and(emailIntentWhere, sql`${emailResourceId} LIKE '%email-7'`, eq(sideEffectIntent.status, 'completed')),
		{ table: sideEffectIntent, column: sideEffectIntent.createdAt },
	)
	const isMidPathEmail = (value: string) => /(?:^|\.)(?:team-)?email-[1-6]$/.test(value)
	const countByEmail = async (where: any) => {
		const rows = await db
			.select({ emailResourceId, value: count() })
			.from(sideEffectIntent)
			.where(where)
			.groupBy(emailResourceId)
		return Object.fromEntries(rows.flatMap((row) => {
			const id = String(row.emailResourceId ?? '')
			return isMidPathEmail(id) ? [[id, Number(row.value ?? 0)]] : []
		}))
	}
	const rangeEmailWhere = and(emailIntentWhere, gte(sideEffectIntent.createdAt, start), sql`${sideEffectIntent.createdAt} < ${end}`)
	const midPathByEmail = { today: await countByEmail(rangeEmailWhere), total: await countByEmail(emailIntentWhere) }
	const signupContacts = await db
		.select({ attribution: contact.optInAttribution, createdAt: contact.createdAt })
		.from(contact)
		.where(
			and(
				sql`${contact.id} IN (SELECT DISTINCT contactId FROM AI_ContactEvent WHERE eventType = 'skills-newsletter.subscribed')`,
				excludeLearnerFlowCanary({ email: contact.email }),
			),
		)
	const conversions = await db
		.select({ status: googleAdsSignupConversionUpload.status, createdAt: googleAdsSignupConversionUpload.createdAt })
		.from(googleAdsSignupConversionUpload)
		.where(
			excludeLearnerFlowCanary({
				contactId: googleAdsSignupConversionUpload.contactId,
			}),
		)
	const countConversionStatuses = (rows: typeof conversions) =>
		Object.fromEntries(['processing', 'uploaded', 'failed'].map((status) => [status, rows.filter((row) => row.status === status).length]))
	const rangeContacts = signupContacts.filter((row) => inWindow(row.createdAt, start, end))
	const rangeConversions = conversions.filter((row) => inWindow(row.createdAt, start, end))
	const attributedCount = (rows: typeof signupContacts) => rows.filter((row) => hasAttribution(row.attribution)).length
	const stages = { signups, events: signups, uniqueLearners, contacts, emailZeroPlanned: emailZero, emailZeroSent: sent, allEmailsSent: allSent, midPath, terminal }
	return {
		generatedAt: now.toISOString(),
		readOnly: true,
		range,
		window: {
			kind: window.kind,
			label: window.label,
			timeZone: window.timeZone,
			startAt: start.toISOString(),
			endAt: end.toISOString(),
		},
		stageSemantics: {
			signups: 'subscription event records',
			events: 'alias of signups subscription event records',
			uniqueLearners: 'distinct ContactEvent.contactId values with a subscription event',
			contacts: 'contact records associated with any subscription event, filtered by contact creation time',
			emailZeroPlanned: 'side-effect intent records',
			emailZeroSent: 'completed side-effect intent records',
			allEmailsSent: 'completed side-effect intent records',
			midPath: 'side-effect intent records',
			terminal: 'completed side-effect intent records',
		},
		stages,
		dropOff: {
			eventToUniqueLearner: { range: signups.range - uniqueLearners.range, total: signups.total - uniqueLearners.total },
			uniqueLearnerToContact: { range: uniqueLearners.range - contacts.range, total: uniqueLearners.total - contacts.total },
			eventToContact: { range: signups.range - contacts.range, total: signups.total - contacts.total },
			contactToEmailZero: { range: contacts.range - emailZero.range, total: contacts.total - emailZero.total },
			emailZeroToSent: { range: emailZero.range - sent.range, total: emailZero.total - sent.total },
		},
		midPathByEmail,
		attribution: {
			range: { captured: attributedCount(rangeContacts), total: rangeContacts.length, rate: rangeContacts.length ? attributedCount(rangeContacts) / rangeContacts.length : 0 },
			total: { captured: attributedCount(signupContacts), total: signupContacts.length, rate: signupContacts.length ? attributedCount(signupContacts) / signupContacts.length : 0 },
		},
		conversion: { range: countConversionStatuses(rangeConversions), total: countConversionStatuses(conversions) },
	}
}

async function accessToken(config: ReturnType<typeof readGoogleAdsConversionUploadConfig>) {
	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: config.clientId ?? '',
			client_secret: config.clientSecret ?? '',
			refresh_token: config.refreshToken ?? '',
			grant_type: 'refresh_token',
		}),
	})
	const body = (await response.json()) as { access_token?: string; error_description?: string }
	if (!response.ok || !body.access_token) throw new Error(body.error_description ?? 'Google OAuth token exchange failed')
	return body.access_token
}

export async function getAdsCourseCampaignMetrics(options: {
	productId?: string
	range?: AdsMetricsRange
	allSourceSignups: number
}) {
	const productId = options.productId ?? 'email-course'
	const range = options.range ?? 'today'
	const campaignIds = CAMPAIGN_IDS[productId]
	if (!campaignIds?.length) throw new Error(`No campaign IDs configured for ${productId}`)
	const config = readGoogleAdsConversionUploadConfig()
	const required = [config.customerId, config.loginCustomerId, config.developerToken, config.clientId, config.clientSecret, config.refreshToken]
	if (required.some((value) => !value)) throw new Error('Google Ads reporting credentials are incomplete')
	const query = `SELECT campaign.id, campaign.name, ad_group.name, ad_group.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.average_cpc FROM ad_group WHERE segments.date DURING ${googleDateClause(range)} AND campaign.id IN (${campaignIds.join(',')}) ORDER BY metrics.cost_micros DESC`
	const response = await fetch(`https://googleads.googleapis.com/v21/customers/${config.customerId!.replace(/-/g, '')}/googleAds:searchStream`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${await accessToken(config)}`,
			'developer-token': config.developerToken!,
			'login-customer-id': config.loginCustomerId!.replace(/-/g, ''),
			'content-type': 'application/json',
		},
		body: JSON.stringify({ query }),
	})
	const body = (await response.json()) as any
	if (!response.ok) throw new Error(`Google Ads report failed: ${JSON.stringify(body)}`)
	const rows = Array.isArray(body) ? body.flatMap((chunk) => chunk.results ?? []) : []
	const adGroups = rows.map((row: any) => {
		const costUsd = Number(row.metrics?.costMicros ?? 0) / 1_000_000
		const clicks = Number(row.metrics?.clicks ?? 0)
		return {
			campaign: row.campaign?.name ?? null,
			adGroup: row.adGroup?.name ?? null,
			status: row.adGroup?.status ?? null,
			impressions: Number(row.metrics?.impressions ?? 0),
			clicks,
			costUsd,
			ctr: Number(row.metrics?.ctr ?? 0),
			avgCpcUsd: clicks ? costUsd / clicks : 0,
		}
	})
	const totals = adGroups.reduce(
		(acc, row) => ({ impressions: acc.impressions + row.impressions, clicks: acc.clicks + row.clicks, costUsd: acc.costUsd + row.costUsd }),
		{ impressions: 0, clicks: 0, costUsd: 0 },
	)
	return {
		readAt: new Date().toISOString(),
		readOnly: true,
		productId,
		range,
		campaignIds,
		totals: {
			...totals,
			allSourceSignups: options.allSourceSignups,
			blendedCostPerAllSourceSignupUsd: options.allSourceSignups
				? totals.costUsd / options.allSourceSignups
				: null,
		},
		adGroups,
	}
}

export async function getAdsCourseMetrics(options: { productId?: string; range?: AdsMetricsRange } = {}) {
	const funnel = await getAdsCourseFunnelMetrics({ range: options.range })
	const ads = await getAdsCourseCampaignMetrics({
		productId: options.productId,
		range: options.range,
		allSourceSignups: funnel.stages.uniqueLearners.range,
	})
	return { generatedAt: new Date().toISOString(), readOnly: true, productId: options.productId ?? 'email-course', range: options.range ?? 'today', ads, funnel }
}
