import { db } from '@/db'
import {
	contact,
	contactEvent,
	contactState,
	googleAdsSignupConversionUpload,
} from '@/db/schema'
import { prepareGoogleAdsSignupConversion } from '@/lib/google-ads-signup-conversion-upload'
import type { OptInAttribution } from '@/lib/subscriber-marketing/opt-in-attribution'
import { and, count, countDistinct, desc, eq, gte, inArray, sql } from 'drizzle-orm'

type LedgerStatus = 'processing' | 'uploaded' | 'failed' | 'validated'

export function summarizeLocalSignupConversionStatus(input: {
	realGclidContactIds: readonly string[]
	ledgerRows: readonly { contactId: string; status: string }[]
}) {
	const latestStatusByContact = new Map<string, string>()
	for (const row of input.ledgerRows) {
		if (!latestStatusByContact.has(row.contactId)) {
			latestStatusByContact.set(row.contactId, row.status)
		}
	}
	const countStatus = (status: LedgerStatus) =>
		input.realGclidContactIds.filter(
			(contactId) => latestStatusByContact.get(contactId) === status,
		).length
	const unrecorded = input.realGclidContactIds.filter(
		(contactId) => !latestStatusByContact.has(contactId),
	).length
	const processing = countStatus('processing')
	return {
		recordedRealGclidSignups: input.realGclidContactIds.length,
		pending: unrecorded + processing,
		unrecorded,
		processing,
		uploaded: countStatus('uploaded') + countStatus('validated'),
		failed: countStatus('failed'),
	}
}

export async function getLocalSignupConversionStatus(options: {
	startAt: Date
	endAt: Date
	limit?: number
}) {
	const limit = options.limit ?? 5000
	const rows = await db
		.select({
			contactId: contact.id,
			attribution: contactState.optInAttribution,
		})
		.from(contactState)
		.innerJoin(contact, eq(contact.id, contactState.contactId))
		.orderBy(desc(contactState.updatedAt))
		.limit(limit)
	const candidates = rows.flatMap((row) => {
		const attribution = row.attribution as OptInAttribution | null
		const occurredAt = attribution?.subscribedAt
		if (!attribution || !occurredAt) return []
		const occurred = new Date(occurredAt)
		return occurred >= options.startAt && occurred < options.endAt
			? [{ contactId: row.contactId, occurredAt, attribution }]
			: []
	})
	const realGclidContactIds = [
		...new Set(
			candidates.flatMap((candidate) => {
				const prepared = prepareGoogleAdsSignupConversion({
					candidate,
					conversionActionResourceName: 'read-only-status-probe',
				})
				return prepared.ok && prepared.conversion.clickIdType === 'gclid'
					? [candidate.contactId]
					: []
			}),
		),
	]
	const ledgerRows = realGclidContactIds.length
		? await db
				.select({
					contactId: googleAdsSignupConversionUpload.contactId,
					status: googleAdsSignupConversionUpload.status,
				})
				.from(googleAdsSignupConversionUpload)
				.where(
					inArray(
						googleAdsSignupConversionUpload.contactId,
						realGclidContactIds,
					),
				)
				.orderBy(desc(googleAdsSignupConversionUpload.updatedAt))
		: []
	const [allSource] = await db
		.select({
			events: count(),
			uniqueLearners: countDistinct(contactEvent.contactId),
		})
		.from(contactEvent)
		.where(
			and(
				eq(contactEvent.eventType, 'skills-newsletter.subscribed'),
				gte(contactEvent.occurredAt, options.startAt),
				sql`${contactEvent.occurredAt} < ${options.endAt}`,
			),
		)

	return {
		readOnly: true,
		window: {
			startAt: options.startAt.toISOString(),
			endAt: options.endAt.toISOString(),
		},
		localConversionStatus: summarizeLocalSignupConversionStatus({
			realGclidContactIds,
			ledgerRows,
		}),
		allSourceSignups: {
			events: Number(allSource?.events ?? 0),
			uniqueLearners: Number(allSource?.uniqueLearners ?? 0),
			countTypes: {
				events: 'skills-newsletter.subscribed ContactEvent records',
				uniqueLearners: 'distinct ContactEvent.contactId values',
			},
		},
		candidateScanLimit: limit,
		candidateScanTruncated: rows.length === limit,
		privacy:
			'aggregate-only-no-click-ids-no-emails-no-contact-ids-no-ledger-ids',
	}
}
