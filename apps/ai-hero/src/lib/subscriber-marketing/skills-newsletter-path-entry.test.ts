import { describe, expect, it } from 'vitest'

import {
	EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
	deadlineTimeZoneEvidenceFromHeader,
} from './course-sequence-exhaustion'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import { enterSkillsNewsletterSubscriber } from './skills-newsletter-path-entry'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'

const subscribedAt = '2026-08-30T02:00:00.000Z'

function rollingAllowlist(): GateDRuntimeAllowlist {
	return {
		activationId: 'course-entry-evidence-test',
		status: 'active',
		killSwitch: false,
		mode: 'scoped-live',
		authorizationMode: 'rolling-public-enrollment',
		pathSlugs: ['ai-hero-skills-workflow'],
		contactIds: [],
		kitSubscriberIds: [],
		emails: [],
		emailHashes: [],
		emailResourceIds: ['ai-hero-skills-workflow.email-0'],
		kitSequenceIds: ['2757199'],
		candidates: [],
		allowedActions: ['send-path-emails'],
		createdAt: subscribedAt,
	}
}

describe('Skills newsletter path entry schedule evidence', () => {
	it('pins browser timezone evidence on entry and Email 0 metadata', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const deadline = deadlineTimeZoneEvidenceFromHeader({
			headerValue: 'Asia/Tokyo',
			capturedAt: subscribedAt,
		})
		if (!deadline.ok) throw new Error(deadline.error.detail)

		const result = await enterSkillsNewsletterSubscriber({
			repository,
			allowlist: rollingAllowlist(),
			allowWrite: true,
			sequenceExhaustionEnabled: true,
			input: {
				kitSubscriberId: 'kit-1',
				email: 'learner@example.com',
				formId: 9376133,
				source: 'aihero_skills_page',
				subscribedAt,
				deadlineTimeZone: deadline.value,
			},
		})
		const entry = Array.from(repository.contactEvents.values()).find(
			(event) => event.eventType === 'value-path.entered',
		)
		const emailZero = Array.from(repository.sideEffectIntents.values()).find(
			(intent) =>
				intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-0',
		)

		expect(result.status).toBe('planned')
		expect(entry).toMatchObject({
			payloadFormat: EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT,
			domainPayload: {
				deadlineTimeZone: deadline.value,
			},
		})
		expect(emailZero).toMatchObject({
			metadata: {
				courseEntryEventId: entry?.id,
				courseDeadlineTimeZone: deadline.value,
			},
		})
	})

	it('uses explicit Pacific fallback for confirmation or replay events', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		await enterSkillsNewsletterSubscriber({
			repository,
			allowlist: rollingAllowlist(),
			allowWrite: true,
			sequenceExhaustionEnabled: true,
			input: {
				kitSubscriberId: 'kit-legacy',
				email: 'legacy@example.com',
				formId: 9376133,
				source: 'kit-confirmation-reconciler',
				subscribedAt,
			},
		})
		const entry = Array.from(repository.contactEvents.values()).find(
			(event) => event.eventType === 'value-path.entered',
		)

		expect(entry?.domainPayload).toMatchObject({
			deadlineTimeZone: {
				type: 'ExplicitFallback',
				reason: 'legacy-entry',
				timeZone: 'America/Los_Angeles',
			},
		})
	})
})

/** Only the course emails matter; capture plans its own internal intents. */
function valuePathEmailIntents(
	repository: InMemorySubscriberMarketingRepository,
) {
	return Array.from(repository.sideEffectIntents.values()).filter(
		(intent) => intent.type === 'send-value-path-email',
	)
}

describe('Skills newsletter path entry: drovr ownership', () => {
	const input = {
		kitSubscriberId: 'kit-9',
		email: 'owned@example.com',
		formId: 9376133,
		source: 'aihero_skills_page' as const,
		subscribedAt,
	}

	it('records ownership and plans no legacy Email 0 for a drovr-owned signup', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await enterSkillsNewsletterSubscriber({
			repository,
			allowlist: rollingAllowlist(),
			allowWrite: true,
			input,
			drovrOwnership: { percent: 100, emails: new Set() },
		})
		expect(result.status).toBe('drovr-owned')
		expect(result.entry.counts).toMatchObject({ planned: 0, blocked: 0 })
		const events = Array.from(repository.contactEvents.values())
		expect(events.map((event) => event.eventType).sort()).toEqual([
			'journey.owner.assigned',
			'skills-newsletter.subscribed',
		])
		expect(valuePathEmailIntents(repository)).toHaveLength(0)
	})

	it('keeps ownership sticky across a replayed signup and records it once', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		await enterSkillsNewsletterSubscriber({
			repository,
			allowlist: rollingAllowlist(),
			allowWrite: true,
			input,
			drovrOwnership: { percent: 100, emails: new Set() },
		})
		const replay = await enterSkillsNewsletterSubscriber({
			repository,
			allowlist: rollingAllowlist(),
			allowWrite: true,
			input: { ...input, source: 'signup-gap-replay' },
			drovrOwnership: { percent: 0, emails: new Set() },
		})
		expect(replay.status).toBe('drovr-owned')
		const owners = Array.from(repository.contactEvents.values()).filter(
			(event) => event.eventType === 'journey.owner.assigned',
		)
		expect(owners).toHaveLength(1)
		expect(valuePathEmailIntents(repository)).toHaveLength(0)
	})

	it('routes an allowlisted email to drovr at 0% and everyone else to legacy', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const owned = await enterSkillsNewsletterSubscriber({
			repository,
			allowlist: rollingAllowlist(),
			allowWrite: true,
			input,
			drovrOwnership: { percent: 0, emails: new Set(['owned@example.com']) },
		})
		expect(owned.status).toBe('drovr-owned')
		const legacy = await enterSkillsNewsletterSubscriber({
			repository,
			allowlist: rollingAllowlist(),
			allowWrite: true,
			input: {
				...input,
				kitSubscriberId: 'kit-10',
				email: 'other@example.com',
			},
			drovrOwnership: { percent: 0, emails: new Set(['owned@example.com']) },
		})
		expect(legacy.status).toBe('planned')
	})

	it('never flips a contact the legacy planner already started', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const first = await enterSkillsNewsletterSubscriber({
			repository,
			allowlist: rollingAllowlist(),
			allowWrite: true,
			input,
		})
		expect(first.status).toBe('planned')
		const replay = await enterSkillsNewsletterSubscriber({
			repository,
			allowlist: rollingAllowlist(),
			allowWrite: true,
			input: { ...input, source: 'signup-gap-replay' },
			drovrOwnership: { percent: 100, emails: new Set() },
		})
		expect(replay.status).not.toBe('drovr-owned')
		expect(
			Array.from(repository.contactEvents.values()).some(
				(event) => event.eventType === 'journey.owner.assigned',
			),
		).toBe(false)
	})
})
