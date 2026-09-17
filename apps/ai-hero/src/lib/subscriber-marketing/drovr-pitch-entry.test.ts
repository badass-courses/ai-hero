import { describe, expect, it, vi } from 'vitest'

import {
	decidePitchEligibility,
	enterEvergreenPitch,
	hasCrashCoursePurchaseForIdentity,
	type EvergreenPitchEntryEvidence,
	type EvergreenPitchEntryRepository,
} from './drovr-pitch-entry'
import { mapDrovrShadowFact } from './drovr-shadow-emitter'
import type { ContactEventRecord } from './types'

const completedAt = '2026-09-17T18:23:00.000Z'

function evidence(
	overrides: Partial<EvergreenPitchEntryEvidence> = {},
): EvergreenPitchEntryEvidence {
	return {
		contact: {
			id: 'contact-1',
			userId: 'user-1',
			email: 'learner@example.com',
			name: 'Learner',
			lifecycle: 'nurture-ready',
			isProvisional: false,
			createdAt: '2026-08-01T00:00:00.000Z',
			updatedAt: completedAt,
		},
		providerIdentity: {
			id: 'identity-1',
			contactId: 'contact-1',
			provider: 'kit',
			externalId: 'kit-1',
			evidence: {
				source: 'kit',
				strength: 'strong',
				email: 'learner@example.com',
				providerIdentity: { provider: 'kit', externalId: 'kit-1' },
			},
			createdAt: '2026-08-01T00:00:00.000Z',
			updatedAt: completedAt,
		},
		hasCrashCoursePurchase: false,
		unsubscribed: false,
		...overrides,
	}
}

function repository(args: {
	evidence?: EvergreenPitchEntryEvidence
	events?: ContactEventRecord[]
}) {
	const createContactEvent = vi.fn(
		(
			input: Parameters<EvergreenPitchEntryRepository['createContactEvent']>[0],
		) =>
			({
				id: 'assignment-1',
				createdAt: input.createdAt ?? completedAt,
				...input,
			}) as ContactEventRecord,
	)
	const value: EvergreenPitchEntryRepository = {
		readEvergreenPitchEntryEvidence: vi.fn(async () => args.evidence),
		findContactEventsByType: vi.fn(async () => args.events ?? []),
		createContactEvent,
	}
	return { value, createContactEvent }
}

describe('evergreen pitch eligibility', () => {
	it('requires a finished course, no live Crash Course purchase, and no unsubscribe', () => {
		expect(
			decidePitchEligibility({
				finishedCourse: true,
				hasCrashCoursePurchase: false,
				unsubscribed: false,
			}),
		).toEqual({ eligible: true })
		expect(
			decidePitchEligibility({
				finishedCourse: false,
				hasCrashCoursePurchase: false,
				unsubscribed: false,
			}),
		).toEqual({ eligible: false, reason: 'course-not-finished' })
		expect(
			decidePitchEligibility({
				finishedCourse: true,
				hasCrashCoursePurchase: true,
				unsubscribed: false,
			}),
		).toEqual({ eligible: false, reason: 'crash-course-purchaser' })
		expect(
			decidePitchEligibility({
				finishedCourse: true,
				hasCrashCoursePurchase: false,
				unsubscribed: true,
			}),
		).toEqual({ eligible: false, reason: 'unsubscribed' })
	})

	it('matches Valid or Restricted product-ma254 purchases by user or normalized email', () => {
		const purchases = [
			{
				userId: 'user-other-email',
				userEmail: 'other-address@example.com',
				productId: 'product-ma254',
				status: 'Restricted',
			},
			{
				userId: 'user-by-email',
				userEmail: ' Learner@Example.com ',
				productId: 'product-ma254',
				status: 'Valid',
			},
		]
		expect(
			hasCrashCoursePurchaseForIdentity({
				userIds: ['user-other-email'],
				emails: [],
				purchases,
			}),
		).toBe(true)
		expect(
			hasCrashCoursePurchaseForIdentity({
				userIds: [],
				emails: ['learner@example.com'],
				purchases,
			}),
		).toBe(true)
		expect(
			hasCrashCoursePurchaseForIdentity({
				userIds: ['someone-else'],
				emails: ['nobody@example.com'],
				purchases,
			}),
		).toBe(false)
	})
})

describe('enterEvergreenPitch', () => {
	it('records one evergreen assignment whose emitter births no skills-course actor', async () => {
		const fake = repository({ evidence: evidence() })
		await expect(
			enterEvergreenPitch({
				repository: fake.value,
				contactId: 'contact-1',
				completedAt,
			}),
		).resolves.toEqual({
			status: 'entered',
			journeyId: 'crash-course-evergreen-offer',
		})
		expect(fake.createContactEvent).toHaveBeenCalledTimes(1)
		const assignment = fake.createContactEvent.mock.results[0]!.value
		expect(assignment.providerEventId).toBe(
			'drovr-owner:contact-1:crash-course-evergreen-offer',
		)
		const births = mapDrovrShadowFact({
			kind: 'contact-event',
			event: assignment,
		})
		expect(births).toEqual([
			expect.objectContaining({
				tenantId: 'org-aihero',
				journeyId: 'crash-course-evergreen-offer',
				type: 'contact.created',
				occurredAt: completedAt,
			}),
		])
		expect(
			births.filter((event) => event.journeyId === 'value-path-skills-course'),
		).toHaveLength(0)
	})

	it('reads current purchase evidence at every entry attempt and refuses purchasers', async () => {
		const readEvergreenPitchEntryEvidence = vi.fn(async () =>
			evidence({ hasCrashCoursePurchase: true }),
		)
		const fake = repository({ evidence: evidence() })
		fake.value.readEvergreenPitchEntryEvidence = readEvergreenPitchEntryEvidence

		await expect(
			enterEvergreenPitch({
				repository: fake.value,
				contactId: 'contact-1',
				completedAt,
			}),
		).resolves.toEqual({
			status: 'refused',
			reason: 'crash-course-purchaser',
		})
		expect(readEvergreenPitchEntryEvidence).toHaveBeenCalledTimes(1)
		expect(fake.createContactEvent).not.toHaveBeenCalled()
	})

	it('is idempotent within the evergreen journey discriminator', async () => {
		const existing = {
			providerEventId: 'drovr-owner:contact-1:crash-course-evergreen-offer',
		} as ContactEventRecord
		const fake = repository({ evidence: evidence(), events: [existing] })
		await expect(
			enterEvergreenPitch({
				repository: fake.value,
				contactId: 'contact-1',
				completedAt,
			}),
		).resolves.toEqual({
			status: 'already-entered',
			journeyId: 'crash-course-evergreen-offer',
		})
		expect(fake.createContactEvent).not.toHaveBeenCalled()
	})
})
