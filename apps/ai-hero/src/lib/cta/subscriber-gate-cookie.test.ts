import { describe, expect, it } from 'vitest'

import {
	createSubscriberGateSnapshot,
	mergeSubscriberGateSnapshot,
	parseSubscriberGateSnapshot,
} from './subscriber-gate-cookie'

describe('subscriber gate cookie', () => {
	it('keeps only completion facts and stays independent of a large Kit record', () => {
		const snapshot = createSubscriberGateSnapshot({
			id: 42,
			state: 'active',
			fields: {
				interest: 'skills',
				aih_course_started_at: '2026-07-31T12:00:00.000Z',
				waitlist_cohort_four: '2026-07-31',
				interest_workshop: '2026-07-31',
				source: 'not-needed-for-gating',
				unrelated: 'x'.repeat(10_000),
			},
		})

		expect(snapshot).toEqual({
			id: 42,
			state: 'active',
			fields: {
				interest: 'skills',
				aih_course_started_at: '2026-07-31T12:00:00.000Z',
				waitlist_cohort_four: '2026-07-31',
				interest_workshop: '2026-07-31',
			},
		})
		expect(JSON.stringify(snapshot).length).toBeLessThan(500)
	})

	it('merges only a matching subscriber snapshot', () => {
		const subscriber = { id: 42, state: 'active', fields: { existing: 'yes' } }
		const gate = parseSubscriberGateSnapshot(
			JSON.stringify({
				id: 42,
				state: 'active',
				fields: { waitlist_cohort_four: '2026-07-31' },
			}),
		)

		expect(mergeSubscriberGateSnapshot(subscriber, gate)).toEqual({
			id: 42,
			state: 'active',
			fields: {
				existing: 'yes',
				waitlist_cohort_four: '2026-07-31',
			},
		})
		expect(
			mergeSubscriberGateSnapshot(subscriber, {
				id: 7,
				state: 'active',
				fields: { waitlist_wrong_person: '2026-07-31' },
			}),
		).toBe(subscriber)
	})

	it('lets a fresh Kit record replace stale gate state and cleared fields', () => {
		const freshSubscriber = {
			id: 42,
			state: 'inactive',
			fields: { interest: 'newsletter' },
		}
		const staleGate = {
			id: 42,
			state: 'active',
			fields: {
				interest: 'skills',
				aih_course_started_at: '2026-07-31T12:00:00.000Z',
			},
		}

		expect(
			mergeSubscriberGateSnapshot(freshSubscriber, staleGate, 'subscriber'),
		).toEqual(freshSubscriber)
	})
})
