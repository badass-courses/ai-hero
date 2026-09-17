import { describe, expect, it } from 'vitest'

import {
	DROVR_OWNERSHIP_OFF,
	decideJourneyOwner,
	fanOutOwnedEvents,
	journeyOwnerAssignmentJourneyId,
	journeyOwnerProviderEventId,
	ownershipBucket,
	parseDrovrOwnershipConfig,
	resolveJourneyOwner,
} from './drovr-ownership'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const authorityKey = {
	DROVR_SHADOW_INGEST_URL: 'https://drovr.test/events',
	DROVR_API_KEY_ORG_AIHERO: 'k',
}
const off = parseDrovrOwnershipConfig(authorityKey)

describe('drovr ownership config', () => {
	it('defaults to nobody and clamps the percent', () => {
		expect(off).toEqual({ percent: 0, emails: new Set() })
		expect(
			parseDrovrOwnershipConfig({
				...authorityKey,
				AIH_DROVR_OWNER_PERCENT: '250',
			}).percent,
		).toBe(100)
		expect(
			parseDrovrOwnershipConfig({
				...authorityKey,
				AIH_DROVR_OWNER_PERCENT: 'lots',
			}).percent,
		).toBe(0)
	})

	it('is off, whatever the knobs say, unless drovr is reachable for the authority tenant', () => {
		const knobs = {
			AIH_DROVR_OWNER_PERCENT: '100',
			AIH_DROVR_OWNER_EMAILS: 'joel@example.com',
		}
		expect(parseDrovrOwnershipConfig(knobs)).toEqual(DROVR_OWNERSHIP_OFF)
		expect(
			parseDrovrOwnershipConfig({ ...knobs, DROVR_API_KEY_ORG_AIHERO: 'k' }),
		).toEqual(DROVR_OWNERSHIP_OFF)
		expect(
			parseDrovrOwnershipConfig({
				...knobs,
				DROVR_SHADOW_INGEST_URL: 'https://drovr.test/events',
			}),
		).toEqual(DROVR_OWNERSHIP_OFF)
		expect(parseDrovrOwnershipConfig({ ...knobs, ...authorityKey })).toEqual({
			percent: 100,
			emails: new Set(['joel@example.com']),
		})
	})

	it('lowercases and trims the email allowlist', () => {
		expect(
			parseDrovrOwnershipConfig({
				...authorityKey,
				AIH_DROVR_OWNER_EMAILS: ' Joel@Example.com, ,other@example.com',
			}).emails,
		).toEqual(new Set(['joel@example.com', 'other@example.com']))
	})
})

describe('journey owner decision', () => {
	it('is legacy for everyone at 0% and drovr for everyone at 100%', () => {
		for (const contactId of ['a', 'b', 'c', 'contact-42']) {
			expect(decideJourneyOwner({ contactId, config: off })).toBe('legacy')
			expect(
				decideJourneyOwner({
					contactId,
					config: { percent: 100, emails: new Set() },
				}),
			).toBe('drovr')
		}
	})

	it('routes an allowlisted email to drovr even at 0%', () => {
		expect(
			decideJourneyOwner({
				contactId: 'x',
				email: 'Joel@Example.com ',
				config: { percent: 0, emails: new Set(['joel@example.com']) },
			}),
		).toBe('drovr')
	})

	it('buckets deterministically so a contact never flips between runs', () => {
		expect(ownershipBucket('contact-1')).toBe(ownershipBucket('contact-1'))
		expect(ownershipBucket('contact-1')).toBeGreaterThanOrEqual(0)
		expect(ownershipBucket('contact-1')).toBeLessThan(100)
	})
})

describe('journey owner resolution', () => {
	const assignment = {
		id: 'owner-event',
		eventType: 'journey.owner.assigned',
		providerEventId: 'drovr-owner:c:value-path-skills-course',
	}
	const repositoryWith = (recorded: boolean) => ({
		findContactEventsByType: async () =>
			recorded ? [assignment as never] : [],
	})

	it('honors a recorded assignment regardless of the rollout', async () => {
		await expect(
			resolveJourneyOwner({
				repository: repositoryWith(true),
				contactId: 'c',
				alreadyEntered: true,
				config: off,
			}),
		).resolves.toEqual({ owner: 'drovr', recorded: true, assignment })
	})

	it('never flips a contact the legacy planner already started', async () => {
		await expect(
			resolveJourneyOwner({
				repository: repositoryWith(false),
				contactId: 'c',
				alreadyEntered: true,
				config: { percent: 100, emails: new Set() },
			}),
		).resolves.toEqual({ owner: 'legacy', recorded: false })
	})

	it('decides a fresh signup by the rollout', async () => {
		await expect(
			resolveJourneyOwner({
				repository: repositoryWith(false),
				contactId: 'c',
				alreadyEntered: false,
				config: { percent: 100, emails: new Set() },
			}),
		).resolves.toEqual({ owner: 'drovr', recorded: false })
	})
})

describe('journey ownership discriminator', () => {
	it.each([
		'value-path-skills-course',
		'crash-course-evergreen-offer',
	] as const)('round-trips %s through the provider event id', (journeyId) => {
		const providerEventId = journeyOwnerProviderEventId('contact-1', journeyId)
		expect(providerEventId).toBe(`drovr-owner:contact-1:${journeyId}`)
		expect(journeyOwnerAssignmentJourneyId({ providerEventId })).toBe(journeyId)
	})
})

describe('fan-out of owned facts to the authority tenant', () => {
	const shadow = (
		type: DrovrShadowEvent['type'],
		contactId: string,
	): DrovrShadowEvent => ({
		tenantId: 'org-aihero-shadow',
		contactId,
		journeyId: 'value-path-skills-course',
		type,
		occurredAt: '2026-09-16T22:00:00.000Z',
		idempotencyKey: `aihero:${type}:${contactId}`,
	})

	it('copies non-birth, non-completion shadow facts for owned contacts with their own key', () => {
		const events = [
			shadow('contact.created', 'owned'),
			shadow('email.completed', 'owned'),
			shadow('value-path.answer-selected', 'owned'),
			shadow('value-path.answer-selected', 'legacy'),
		]
		const out = fanOutOwnedEvents(events, new Set(['owned']))
		expect(out).toHaveLength(5)
		expect(out[4]).toEqual({
			...events[2],
			tenantId: 'org-aihero',
			idempotencyKey: 'owner:aihero:value-path.answer-selected:owned',
		})
	})

	it('copies only the evergreen exhaustion, never a skills-course exhaustion', () => {
		const skills = shadow('course.sequence-exhausted', 'owned')
		const evergreen = {
			...skills,
			journeyId: 'crash-course-evergreen-offer' as const,
		}
		const out = fanOutOwnedEvents([skills, evergreen], new Set(['owned']))
		expect(out).toHaveLength(3)
		expect(out[2]).toEqual({
			...evergreen,
			tenantId: 'org-aihero',
			idempotencyKey: `owner:${evergreen.idempotencyKey}`,
		})
	})

	it('leaves authority-addressed events alone', () => {
		const authority: DrovrShadowEvent = {
			...shadow('email.completed', 'owned'),
			tenantId: 'org-aihero',
		}
		expect(fanOutOwnedEvents([authority], new Set(['owned']))).toEqual([
			authority,
		])
	})
})
