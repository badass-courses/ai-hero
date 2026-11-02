import { describe, expect, it, vi } from 'vitest'

import {
	classifyInterestRun,
	droppedFromLogRows,
	listAllInngestEvents,
	planInterestRedrive,
} from './interest-fact-redrive'

/** A listing Inngest serves in pages of at most `clamp`, whatever limit asked. */
function pagedListing(total: number, clamp: number, withCursor: boolean) {
	const all = Array.from({ length: total }, (_, i) => ({
		internal_id: `evt-${String(i).padStart(4, '0')}`,
		data: {},
	}))
	return vi.fn(async (cursor: string | undefined) => {
		const start = cursor
			? all.findIndex((event) => event.internal_id === cursor) + 1
			: 0
		const data = all.slice(start, start + clamp)
		return withCursor ? { data, cursor: data.at(-1)?.internal_id } : { data }
	})
}

const dropped = {
	status: 'Completed',
	output: { local: 'no-contact', drovr: 'unresolved' },
}

describe('interest fact re-drive (dry run)', () => {
	it('a single-wait run that still needed a contact is dropped', () => {
		expect(classifyInterestRun(dropped)).toBe('dropped')
		expect(
			classifyInterestRun({
				status: 'Completed',
				output: { local: 'inserted', drovr: 'unresolved' },
			}),
		).toBe('dropped')
		expect(
			classifyInterestRun({
				status: 'Completed',
				output: { local: 'inserted', drovr: 'recorded' },
			}),
		).toBe('recorded')
	})

	it('a failed run is the held drovr 403 class, and a new-code run is never dropped', () => {
		expect(classifyInterestRun({ status: 'Failed' })).toBe('failed')
		expect(classifyInterestRun({ status: 'Running' })).toBe('waiting')
		expect(
			classifyInterestRun({
				status: 'Completed',
				output: { local: 'no-contact', drovr: 'unresolved', wait: 'expired' },
			}),
		).toBe('expired')
	})

	it('re-drives each person and list once, and not when another run settled it', () => {
		const join = (email: string, fieldKey: string, via = 'form') => ({
			email,
			fieldKey,
			via,
		})
		const plan = planInterestRedrive([
			{ data: join('a@example.test', 'waitlist_c3'), runs: [dropped] },
			// The same join twice (a replay) re-drives once.
			{ data: join('A@example.test ', 'waitlist_c3'), runs: [dropped] },
			{
				data: join('b@example.test', 'waitlist_c4', 'one-click'),
				runs: [dropped],
			},
			// Recorded by a later run: nothing to re-drive.
			{ data: join('c@example.test', 'waitlist_c3'), runs: [dropped] },
			{
				data: join('c@example.test', 'waitlist_c3'),
				runs: [
					{
						status: 'Completed',
						output: { local: 'inserted', drovr: 'recorded' },
					},
				],
			},
			{
				data: join('d@example.test', 'waitlist_c3'),
				runs: [{ status: 'Failed' }],
			},
		])
		expect(plan).toEqual({
			events: 6,
			runs: {
				dropped: 4,
				failed: 1,
				recorded: 1,
				waiting: 0,
				expired: 0,
				other: 0,
			},
			wouldRedrive: 2,
			wouldRedriveByVia: { form: 1, 'one-click': 1 },
			wouldRedriveByFieldKey: { waitlist_c3: 1, waitlist_c4: 1 },
		})
		expect(JSON.stringify(plan)).not.toContain('@')
	})

	it('reads every page when Inngest clamps the page size below the limit asked', async () => {
		for (const withCursor of [true, false]) {
			const fetchPage = pagedListing(109, 51, withCursor)
			const listing = await listAllInngestEvents(fetchPage, 100)
			expect(listing.events).toHaveLength(109)
			expect(new Set(listing.events.map((e) => e.internal_id)).size).toBe(109)
			// 51 + 51 + 7, then an empty page ends it.
			expect(fetchPage).toHaveBeenCalledTimes(4)
			expect(listing.truncated).toBe(false)
		}
	})

	it('stops on a cursor that does not move, and flags a page cap', async () => {
		const stuck = vi.fn(async () => ({
			data: [{ internal_id: 'evt-1' }],
			cursor: 'same',
		}))
		const once = await listAllInngestEvents(stuck, 100)
		expect(stuck).toHaveBeenCalledTimes(2)
		expect(once.events).toHaveLength(1)

		const capped = await listAllInngestEvents(pagedListing(200, 51, true), 2)
		expect(capped).toMatchObject({ pages: 2, truncated: true })
		expect(capped.events).toHaveLength(102)
	})

	it('counts dropped joins from log rows without addresses', () => {
		expect(
			droppedFromLogRows([
				{
					local: 'no-contact',
					drovr: 'unresolved',
					wait: '',
					via: 'form',
					fieldKey: 'waitlist_c3',
					total: 1,
				},
				{
					local: 'no-contact',
					drovr: 'unresolved',
					wait: '',
					via: 'one-click',
					fieldKey: 'waitlist_c3',
					total: 2,
				},
				{
					local: 'no-contact',
					drovr: 'unresolved',
					wait: 'expired',
					via: 'form',
					fieldKey: 'waitlist_c3',
					total: 5,
				},
				{
					local: 'inserted',
					drovr: 'recorded',
					wait: '',
					via: 'form',
					fieldKey: 'waitlist_c3',
					total: 7,
				},
			]),
		).toEqual({
			dropped: 3,
			notDropped: 12,
			byVia: { form: 1, 'one-click': 2 },
			byFieldKey: { waitlist_c3: 3 },
		})
	})
})
