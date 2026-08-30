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
				intent.metadata.emailResourceId ===
				'ai-hero-skills-workflow.email-0',
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
