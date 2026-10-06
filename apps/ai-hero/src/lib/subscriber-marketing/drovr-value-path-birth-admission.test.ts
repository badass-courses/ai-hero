import { describe, expect, it, vi } from 'vitest'

import {
	admitValuePathBirths,
	unsubscribedBirthContactIds,
} from './drovr-value-path-birth-admission'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import { ingestKitDirectoryBatch } from './kit-directory-ingest'
import { buildContactUnsubscribedEvent } from './lifecycle-contact-events'

const at = '2026-10-05T10:00:00.000Z'
const birth = (contactId: string): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	contactId,
	journeyId: 'value-path-skills-course',
	type: 'contact.created',
	occurredAt: at,
	idempotencyKey: `birth:${contactId}`,
})

// Preferences and account-wide Kit unsubscribe webhooks produce this event.
// Kit-footer tag-only changes and drovr-page intent-only opt-outs do not.
const recordedOptOut = (contactId: string, source: string) => ({
	contactId,
	...buildContactUnsubscribedEvent(
		{
			email: 'private@example.test',
			kitSubscriberId: '123',
			preferenceKey: 'ai-skills',
			source,
			occurredAt: at,
		},
		{ email: 'private@example.test', source: 'kit', strength: 'strong' },
	),
})

it('skips a recorded preference opt-out (also mirrored to the Kit tag) and logs ids/counts only', async () => {
	const info = vi.fn()
	const event = {
		...birth('stopped'),
		payload: {
			profileVersion: 1,
			email: 'private@example.test',
			firstName: null,
			holds: [],
		},
	}
	const read = vi.fn(async () => [
		...unsubscribedBirthContactIds([
			recordedOptOut('stopped', 'preferences-page'),
		]),
	])
	expect(await admitValuePathBirths({ events: [event], read, info })).toEqual({
		events: [],
		skipped: 1,
	})
	expect(info).toHaveBeenCalledWith(
		'drovr.value_path.births_skipped_unsubscribed',
		{ count: 1, contactIds: ['stopped'] },
	)
	expect(JSON.stringify(info.mock.calls)).not.toContain('@')
})

describe('recorded account-wide Kit unsubscribe', () => {
	it('keeps active births, other journeys and stop facts in a mixed batch', async () => {
		const active = birth('active')
		const other: DrovrShadowEvent = {
			...birth('stopped'),
			journeyId: 'crash-course-evergreen-offer',
		}
		const fact: DrovrShadowEvent = {
			...birth('stopped'),
			type: 'contact.unsubscribed',
		}
		expect(
			await admitValuePathBirths({
				events: [birth('stopped'), active, other, fact],
				read: async () => [
					...unsubscribedBirthContactIds([
						recordedOptOut('stopped', 'kit-webhook'),
					]),
				],
				info: vi.fn(),
			}),
		).toEqual({ events: [active, other, fact], skipped: 1 })
	})

	it('a fresh DOI lifts a recorded unsubscribe, but a later unsubscribe wins', () => {
		const stopped = recordedOptOut('c', 'kit-webhook')
		const lift = {
			contactId: 'c',
			eventType: 'contact.resubscribed',
			occurredAt: '2026-10-05T11:00:00Z',
		}
		expect(unsubscribedBirthContactIds([stopped, lift])).toEqual(new Set())
		expect(
			unsubscribedBirthContactIds([
				stopped,
				lift,
				{ ...stopped, occurredAt: lift.occurredAt },
			]),
		).toEqual(new Set(['c']))
	})
})

it('does not turn stale directory state into a permanent stop for a re-signup', async () => {
	const repository = new InMemorySubscriberMarketingRepository()
	await ingestKitDirectoryBatch({
		repository,
		now: at,
		batch: [
			{
				id: '123',
				state: 'cancelled',
				createdAt: '2025-01-01T00:00:00Z',
				email: 'private@example.test',
			},
		],
	})
	const identity = repository.findProviderIdentity('kit', '123')!
	expect(identity.evidence.state).toBe('cancelled')
	const events = repository.findContactEventsByType(
		identity.contactId,
		'contact.unsubscribed',
	)
	const currentBirth = birth(identity.contactId)
	expect(
		await admitValuePathBirths({
			events: [currentBirth],
			read: async () => [...unsubscribedBirthContactIds(events)],
			info: vi.fn(),
		}),
	).toEqual({ events: [currentBirth], skipped: 0 })
})

it.each(['Kit footer tag only', 'drovr page intent only'])(
	'%s without a local ContactEvent remains outside this recorded-event admission',
	async () => {
		// Drovr still suppresses sends. This narrow producer filter cannot see
		// these sources and must not create an unliftable snapshot/intent stop.
		const event = birth('not-mirrored')
		expect(
			await admitValuePathBirths({
				events: [event],
				read: async () => [],
				info: vi.fn(),
			}),
		).toEqual({ events: [event], skipped: 0 })
	},
)
