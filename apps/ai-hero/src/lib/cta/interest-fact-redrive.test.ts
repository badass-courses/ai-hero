import { describe, expect, it } from 'vitest'

import {
	classifyInterestRun,
	droppedFromLogRows,
	planInterestRedrive,
} from './interest-fact-redrive'

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
