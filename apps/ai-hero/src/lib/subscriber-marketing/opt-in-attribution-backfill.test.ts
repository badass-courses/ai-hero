import { describe, expect, it } from 'vitest'

import type { OptInAttribution } from './opt-in-attribution'
import {
	backfillOptInAttribution,
	parseOptInAttributionBackfillEntries,
	type OptInAttributionBackfillRepository,
} from './opt-in-attribution-backfill'

const attribution: OptInAttribution = {
	utmSource: 'google',
	utmMedium: 'cpc',
	utmCampaign: 'email_course_warmup',
	gclid: 'Cj0KCQjw-recovered-gclid',
	capturedAt: '2026-07-22T09:54:15.538Z',
	subscribedAt: '2026-07-22T09:54:15.538Z',
}

function fakeRepository(overrides?: {
	contactId?: string | null
	contactPresent?: boolean
	statePresent?: boolean | null
}) {
	const writes: Array<{ table: string; contactId: string }> = []
	const repository: OptInAttributionBackfillRepository = {
		resolveKitContactId: async () =>
			overrides?.contactId === undefined ? 'contact-1' : overrides.contactId,
		contactAttributionPresent: async () => overrides?.contactPresent ?? false,
		contactStateAttributionPresent: async () =>
			overrides?.statePresent === undefined ? false : overrides.statePresent,
		fillContactAttribution: async (contactId) => {
			writes.push({ table: 'contact', contactId })
		},
		fillContactStateAttribution: async (contactId) => {
			writes.push({ table: 'contactState', contactId })
		},
	}
	return { repository, writes }
}

describe('opt-in attribution backfill', () => {
	it('fills both tables for an enrolled contact missing attribution', async () => {
		const { repository, writes } = fakeRepository()
		const result = await backfillOptInAttribution({
			repository,
			entries: [{ kitSubscriberId: '4219378520', attribution }],
			allowWrite: true,
		})
		expect(result.counts).toMatchObject({ entries: 1, filled: 1 })
		expect(result.entries[0]).toEqual({
			kitSubscriberId: '4219378520',
			status: 'filled',
			filledTables: ['contact', 'contactState'],
		})
		expect(writes).toEqual([
			{ table: 'contact', contactId: 'contact-1' },
			{ table: 'contactState', contactId: 'contact-1' },
		])
	})

	it('never writes in dry-run and reports would-fill', async () => {
		const { repository, writes } = fakeRepository()
		const result = await backfillOptInAttribution({
			repository,
			entries: [{ kitSubscriberId: '1', attribution }],
			allowWrite: false,
		})
		expect(result.writeStatus).toBe('dry-run')
		expect(result.entries[0]?.status).toBe('would-fill')
		expect(writes).toEqual([])
	})

	it('never overwrites existing attribution', async () => {
		const { repository, writes } = fakeRepository({
			contactPresent: true,
			statePresent: true,
		})
		const result = await backfillOptInAttribution({
			repository,
			entries: [{ kitSubscriberId: '1', attribution }],
			allowWrite: true,
		})
		expect(result.entries[0]?.status).toBe('already-attributed')
		expect(writes).toEqual([])
	})

	it('fills only the table that is missing attribution', async () => {
		const { repository, writes } = fakeRepository({
			contactPresent: true,
			statePresent: false,
		})
		const result = await backfillOptInAttribution({
			repository,
			entries: [{ kitSubscriberId: '1', attribution }],
			allowWrite: true,
		})
		expect(result.entries[0]?.filledTables).toEqual(['contactState'])
		expect(writes).toEqual([{ table: 'contactState', contactId: 'contact-1' }])
	})

	it('skips unresolved identities and invalid attribution', async () => {
		const { repository, writes } = fakeRepository({ contactId: null })
		const result = await backfillOptInAttribution({
			repository,
			entries: [
				{ kitSubscriberId: 'missing', attribution },
				{
					kitSubscriberId: 'no-subscribed-at',
					attribution: { ...attribution, subscribedAt: undefined },
				},
			],
			allowWrite: true,
		})
		expect(result.counts).toMatchObject({
			noIdentity: 1,
			invalidAttribution: 1,
			filled: 0,
		})
		expect(writes).toEqual([])
	})

	it('parses entry files strictly', () => {
		expect(() => parseOptInAttributionBackfillEntries({})).toThrow(
			'JSON array',
		)
		expect(() =>
			parseOptInAttributionBackfillEntries([{ kitSubscriberId: '' }]),
		).toThrow('entry 0')
		expect(
			parseOptInAttributionBackfillEntries([
				{ kitSubscriberId: '123', attribution },
			]),
		).toHaveLength(1)
	})
})
