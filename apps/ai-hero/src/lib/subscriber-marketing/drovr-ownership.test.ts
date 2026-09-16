import { describe, expect, it } from 'vitest'

import {
	decideJourneyOwner,
	fanOutOwnedEvents,
	ownershipBucket,
	parseDrovrOwnershipConfig,
	resolveJourneyOwner,
} from './drovr-ownership'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const off = parseDrovrOwnershipConfig({})

describe('drovr ownership config', () => {
	it('defaults to nobody and clamps the percent', () => {
		expect(off).toEqual({ percent: 0, emails: new Set() })
		expect(
			parseDrovrOwnershipConfig({ AIH_DROVR_OWNER_PERCENT: '250' }).percent,
		).toBe(100)
		expect(
			parseDrovrOwnershipConfig({ AIH_DROVR_OWNER_PERCENT: 'lots' }).percent,
		).toBe(0)
	})

	it('lowercases and trims the email allowlist', () => {
		expect(
			parseDrovrOwnershipConfig({
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
	const repositoryWith = (recorded: boolean) => ({
		findContactEventsByType: async () =>
			recorded ? [{ eventType: 'journey.owner.assigned' } as never] : [],
	})

	it('honors a recorded assignment regardless of the rollout', async () => {
		await expect(
			resolveJourneyOwner({
				repository: repositoryWith(true),
				contactId: 'c',
				alreadyEntered: true,
				config: off,
			}),
		).resolves.toEqual({ owner: 'drovr', recorded: true })
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

	it('copies non-birth shadow facts for owned contacts with their own key', () => {
		const events = [
			shadow('contact.created', 'owned'),
			shadow('value-path.answer-selected', 'owned'),
			shadow('value-path.answer-selected', 'legacy'),
		]
		const out = fanOutOwnedEvents(events, new Set(['owned']))
		expect(out).toHaveLength(4)
		expect(out[3]).toEqual({
			...events[1],
			tenantId: 'org-aihero',
			idempotencyKey: 'owner:aihero:value-path.answer-selected:owned',
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
