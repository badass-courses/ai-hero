import { describe, expect, it, vi } from 'vitest'

import {
	admitValuePathBirths,
	unsubscribedBirthContactIds,
} from './drovr-value-path-birth-admission'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const at = '2026-10-05T10:00:00.000Z'
const birth = (contactId: string): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	contactId,
	journeyId: 'value-path-skills-course',
	type: 'contact.created',
	occurredAt: at,
	idempotencyKey: `birth:${contactId}`,
})

// Preference/tag opt-outs and Kit webhooks are persisted as contact.unsubscribed.
// These are the recorded signals, not a provider read or a live Kit fixture.
const tagOptOut = {
	contactId: 'tagged',
	eventType: 'contact.unsubscribed',
	occurredAt: at,
}

it('skips a birth for the recorded AI Hero unsubscribe-tag opt-out and logs ids/counts only', async () => {
	const info = vi.fn()
	const event = {
		...birth('tagged'),
		payload: { profileVersion: 1, email: 'private@example.test', firstName: null, holds: [] },
	}
	const read = vi.fn(async () => [...unsubscribedBirthContactIds([tagOptOut])])
	const result = await admitValuePathBirths({ events: [event], read, info })
	expect(result).toEqual({ events: [], skipped: 1 })
	expect(info).toHaveBeenCalledWith(
		'drovr.value_path.births_skipped_unsubscribed',
		{
			count: 1,
			contactIds: ['tagged'],
		},
	)
	expect(JSON.stringify(info.mock.calls)).not.toContain('@')
})

describe('recorded Kit subscriber state', () => {
	it.each(['cancelled', 'unsubscribed'])(
		'skips %s while an active subscriber still births',
		async (state) => {
			const rows = [
				{
					contactId: 'stopped',
					eventType: 'kit.directory-imported',
					occurredAt: at,
					identityEvidence: { state, email: 'private@example.test' },
				},
				{
					contactId: 'active',
					eventType: 'kit.directory-imported',
					occurredAt: at,
					identityEvidence: { state: 'active' },
				},
			]
			const active = birth('active')
			const other: DrovrShadowEvent = { ...birth('stopped'), journeyId: 'crash-course-evergreen-offer' }
			const fact = {
				...birth('stopped'),
				type: 'contact.unsubscribed' as const,
			}
			const result = await admitValuePathBirths({
				events: [birth('stopped'), active, other, fact],
				read: async () => [...unsubscribedBirthContactIds(rows)],
				info: vi.fn(),
			})
			expect(result).toEqual({ events: [active, other, fact], skipped: 1 })
		},
	)

	it('a fresh DOI lifts recorded state/tag opt-outs, but a later unsubscribe wins', () => {
		const imported = {
			contactId: 'c',
			eventType: 'kit.directory-imported',
			occurredAt: at,
			identityEvidence: { state: 'cancelled' },
		}
		const lift = {
			contactId: 'c',
			eventType: 'contact.resubscribed',
			occurredAt: '2026-10-05T11:00:00Z',
		}
		expect(unsubscribedBirthContactIds([imported, lift])).toEqual(new Set())
		expect(
			unsubscribedBirthContactIds([
				imported,
				lift,
				{ ...tagOptOut, contactId: 'c', occurredAt: lift.occurredAt },
			]),
		).toEqual(new Set(['c']))
	})
})
