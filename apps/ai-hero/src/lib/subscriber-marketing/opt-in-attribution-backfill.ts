import type { OptInAttribution } from '@/lib/subscriber-marketing/opt-in-attribution'
import { compactOptInAttribution } from '@/lib/subscriber-marketing/opt-in-attribution-stash'

/**
 * Fill-if-missing opt-in attribution backfill for enrolled contacts whose
 * attribution was lost between capture and enrollment (e.g. the 7/20–7/24
 * confirmation-gap window, recovered from Axiom request logs). Never
 * overwrites existing attribution in either table; conversion queries and
 * the Google Ads upload cron read contactState, so both tables are filled.
 */

export type OptInAttributionBackfillEntry = {
	kitSubscriberId: string
	attribution: OptInAttribution
}

export type OptInAttributionBackfillRepository = {
	resolveKitContactId: (kitSubscriberId: string) => Promise<string | null>
	contactAttributionPresent: (contactId: string) => Promise<boolean>
	/** null means the contact has no state row at all. */
	contactStateAttributionPresent: (contactId: string) => Promise<boolean | null>
	fillContactAttribution: (
		contactId: string,
		attribution: OptInAttribution,
	) => Promise<void>
	fillContactStateAttribution: (
		contactId: string,
		attribution: OptInAttribution,
	) => Promise<void>
}

export type OptInAttributionBackfillEntryResult = {
	kitSubscriberId: string
	status:
		| 'invalid-attribution'
		| 'no-identity'
		| 'already-attributed'
		| 'would-fill'
		| 'filled'
	filledTables?: Array<'contact' | 'contactState'>
}

export type OptInAttributionBackfillResult = {
	mode: 'optin-attribution-backfill'
	writeStatus: 'dry-run' | 'write'
	counts: {
		entries: number
		invalidAttribution: number
		noIdentity: number
		alreadyAttributed: number
		filled: number
	}
	entries: OptInAttributionBackfillEntryResult[]
	privacy: 'kit-subscriber-ids-and-aggregate-status-only'
}

export async function backfillOptInAttribution(args: {
	repository: OptInAttributionBackfillRepository
	entries: readonly OptInAttributionBackfillEntry[]
	allowWrite: boolean
}): Promise<OptInAttributionBackfillResult> {
	const results: OptInAttributionBackfillEntryResult[] = []

	for (const entry of args.entries) {
		const attribution = compactOptInAttribution(entry.attribution)
		const subscribedAt = entry.attribution.subscribedAt
		if (
			!attribution ||
			!subscribedAt ||
			Number.isNaN(Date.parse(subscribedAt))
		) {
			results.push({
				kitSubscriberId: entry.kitSubscriberId,
				status: 'invalid-attribution',
			})
			continue
		}
		const withSubscription: OptInAttribution = {
			...attribution,
			subscribedAt,
		}

		const contactId = await args.repository.resolveKitContactId(
			entry.kitSubscriberId,
		)
		if (!contactId) {
			results.push({
				kitSubscriberId: entry.kitSubscriberId,
				status: 'no-identity',
			})
			continue
		}

		const contactPresent =
			await args.repository.contactAttributionPresent(contactId)
		const statePresent =
			await args.repository.contactStateAttributionPresent(contactId)
		const fillTables: Array<'contact' | 'contactState'> = []
		if (!contactPresent) fillTables.push('contact')
		if (statePresent === false) fillTables.push('contactState')

		if (fillTables.length === 0) {
			results.push({
				kitSubscriberId: entry.kitSubscriberId,
				status: 'already-attributed',
			})
			continue
		}

		if (!args.allowWrite) {
			results.push({
				kitSubscriberId: entry.kitSubscriberId,
				status: 'would-fill',
				filledTables: fillTables,
			})
			continue
		}

		if (fillTables.includes('contact')) {
			await args.repository.fillContactAttribution(contactId, withSubscription)
		}
		if (fillTables.includes('contactState')) {
			await args.repository.fillContactStateAttribution(
				contactId,
				withSubscription,
			)
		}
		results.push({
			kitSubscriberId: entry.kitSubscriberId,
			status: 'filled',
			filledTables: fillTables,
		})
	}

	return {
		mode: 'optin-attribution-backfill',
		writeStatus: args.allowWrite ? 'write' : 'dry-run',
		counts: {
			entries: args.entries.length,
			invalidAttribution: results.filter(
				(item) => item.status === 'invalid-attribution',
			).length,
			noIdentity: results.filter((item) => item.status === 'no-identity')
				.length,
			alreadyAttributed: results.filter(
				(item) => item.status === 'already-attributed',
			).length,
			filled: results.filter(
				(item) => item.status === 'filled' || item.status === 'would-fill',
			).length,
		},
		entries: results,
		privacy: 'kit-subscriber-ids-and-aggregate-status-only',
	}
}

export function parseOptInAttributionBackfillEntries(
	raw: unknown,
): OptInAttributionBackfillEntry[] {
	if (!Array.isArray(raw)) {
		throw new Error('Backfill entries must be a JSON array')
	}
	return raw.map((value, index) => {
		const record =
			value && typeof value === 'object'
				? (value as Record<string, unknown>)
				: undefined
		const kitSubscriberId =
			typeof record?.kitSubscriberId === 'string'
				? record.kitSubscriberId.trim()
				: ''
		const attribution =
			record?.attribution && typeof record.attribution === 'object'
				? (record.attribution as OptInAttribution)
				: undefined
		if (!kitSubscriberId || !attribution) {
			throw new Error(
				`Backfill entry ${index} needs kitSubscriberId and attribution`,
			)
		}
		return { kitSubscriberId, attribution }
	})
}
