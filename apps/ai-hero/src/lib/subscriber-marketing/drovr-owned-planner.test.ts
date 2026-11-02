import { describe, expect, it } from 'vitest'

import { codingWorkflowFixture } from './__fixtures__/quick-question-fixtures'
import {
	dryRunSubscriberMarketingFixture,
	InMemorySubscriberMarketingRepository,
} from './dry-run'
import { DOI_REQUESTED_EVENT_TYPE } from './drovr-doi-signup'
import { recordJourneyOwnerAssigned } from './drovr-ownership'
import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
} from './drovr-shadow-emitter'
import { parseValuePathAnswerPageResource } from './value-path-answer-page'
import { recordValuePathAnswerProgression } from './value-path-click-progression'
import { progressValuePathDrips } from './value-path-drip-progression'
import {
	normalizeGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
} from './value-path-gate-d-allowlist'
import { startValuePathGateDActivation } from './value-path-gate-d-start'

/**
 * The legacy planners never plan a send for a drovr-owned contact. drovr's
 * actor plans the next email; a legacy row would race the actor's intent and
 * complete without ownership, leaving the actor waiting forever.
 */
async function legacyStarted() {
	const repository = new InMemorySubscriberMarketingRepository()
	const captured = await dryRunSubscriberMarketingFixture({
		repository,
		fixture: codingWorkflowFixture,
		now: '2026-05-15T12:00:00.000Z',
	})
	const state = repository.findCurrentContactState(captured.contact.id)!
	repository.upsertContactState({
		...state,
		lifecycle: 'human-review',
		humanReview: true,
		reviewSignals: [],
		updatedAt: '2026-05-15T12:01:00.000Z',
	})
	const allowlist = normalizeGateDRuntimeAllowlist({
		activationId: 'rig-test-finish-approved-path',
		status: 'active',
		killSwitch: false,
		mode: 'allowlisted-test',
		authorizationMode: 'finish-approved-path',
		pathSlugs: ['ai-hero-skills-workflow'],
		contactIds: [captured.contact.id],
		kitSubscriberIds: ['4089521940'],
		emails: [captured.contact.email!],
		emailHashes: [],
		emailResourceIds: [
			'ai-hero-skills-workflow.email-0',
			'ai-hero-skills-workflow.email-1',
			'ai-hero-skills-workflow.email-2',
		],
		kitSequenceIds: ['2757199', '2757200', '2757201'],
		candidates: [
			{
				contactId: captured.contact.id,
				kitSubscriberId: '4089521940',
				email: captured.contact.email!,
				rationale: ['skills-form', 'quick-question-reply'],
				blockers: [],
			},
		],
		preAuthorizedReviewReasons: ['human-review'],
		createdAt: '2026-05-15T12:00:00.000Z',
	})
	const start = await startValuePathGateDActivation({
		repository,
		allowWrite: true,
		allowlist,
		valuePathSlug: 'ai-hero-skills-workflow',
		emailResourceId: 'ai-hero-skills-workflow.email-0',
		kitSequenceId: '2757199',
		now: '2026-05-15T12:05:00.000Z',
	})
	expect(start.counts).toMatchObject({ planned: 1, blocked: 0 })
	return { repository, captured, allowlist }
}

const sendRows = (repository: InMemorySubscriberMarketingRepository) =>
	Array.from(repository.sideEffectIntents.values())
		.filter((intent) => intent.type === 'send-value-path-email')
		.map((intent) => intent.metadata.emailResourceId)

const click = (input: Awaited<ReturnType<typeof legacyStarted>>) =>
	recordValuePathAnswerProgression({
		repository: input.repository,
		token: {
			contactId: input.captured.contact.id,
			kitSubscriberId: '4089521940',
			valuePathResourceId: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-1',
			sequenceId: 'ai-hero-skills-workflow',
			expiresAt: '2026-05-16T12:00:00.000Z',
		},
		answerPage: parseValuePathAnswerPageResource({
			id: 'answer-email-1-correct',
			type: 'value-path-page',
			fields: {
				kind: 'answer',
				slug: 'skills-workflow-email-1-correct',
				sequenceId: 'ai-hero-skills-workflow',
				emailId: 'email-1',
				optionValue: 'correct',
				nextEmailResourceId: 'ai-hero-skills-workflow.email-2',
				kitSequenceId: '2757201',
			},
		})!,
		mode: input.allowlist.mode,
		sendGate: {
			allowedActions: input.allowlist.allowedActions,
			allowlistedContactIds: input.allowlist.contactIds,
			allowlistedKitSubscriberIds: input.allowlist.kitSubscriberIds,
			allowlistedEmails: input.allowlist.emails,
			enabledValuePathSlugs: input.allowlist.pathSlugs,
			verifiedEmailResourceIds: input.allowlist.emailResourceIds,
			verifiedKitSequenceIds: input.allowlist.kitSequenceIds,
		},
		acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
			allowlist: input.allowlist,
		}),
		now: '2026-05-15T12:10:00.000Z',
	})

const own = (input: Awaited<ReturnType<typeof legacyStarted>>) =>
	recordJourneyOwnerAssigned({
		repository: input.repository,
		contactId: input.captured.contact.id,
		providerIdentityId: 'pi-test',
		kitSubscriberId: '4089521940',
		email: input.captured.contact.email!,
		occurredAt: '2026-05-15T12:02:00.000Z',
	})

const doiBorn = (input: Awaited<ReturnType<typeof legacyStarted>>) =>
	input.repository.createContactEvent({
		contactId: input.captured.contact.id,
		providerIdentityId: 'pi-test',
		provider: 'ai-hero',
		providerEventId: 'doi-request:form-test:ext-test',
		semanticIdempotencyKey: 'doi-request:form-test:ext-test',
		eventType: DOI_REQUESTED_EVENT_TYPE,
		occurredAt: '2026-05-15T12:02:00.000Z',
		message: 'Double opt-in signup',
		privacyLevel: 'internal',
	} as never)

const completeEmail0 = (input: Awaited<ReturnType<typeof legacyStarted>>) => {
	const email0 = Array.from(input.repository.sideEffectIntents.values()).find(
		(intent) =>
			intent.type === 'send-value-path-email' &&
			intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-0',
	)!
	input.repository.updateSideEffectIntent(email0.id, {
		status: 'completed',
		gates: email0.gates,
		reviewReasons: [],
		metadata: { ...email0.metadata, completedAt: '2026-05-15T12:06:00.000Z' },
	})
	return input.repository.sideEffectIntents.get(email0.id)!
}

describe('legacy planners and drovr-owned contacts', () => {
	it('plans no click send for a DOI-born contact with no owner record', async () => {
		const input = await legacyStarted()
		await doiBorn(input)
		const result = await click(input)
		expect(result.status).toBe('recorded')
		expect(result.reviewReasons).toEqual(['drovr-owned'])
		expect(sendRows(input.repository)).toEqual([
			'ai-hero-skills-workflow.email-0',
		])
	})

	it.each([
		['evergreen', DROVR_EVERGREEN_OFFER_JOURNEY_ID],
		['newsletter', DROVR_SHADOW_NEWSLETTER_JOURNEY_ID],
	])(
		'still plans the legacy click send for a contact owned only for %s',
		async (_name, journeyId) => {
			const input = await legacyStarted()
			await recordJourneyOwnerAssigned({
				repository: input.repository,
				contactId: input.captured.contact.id,
				providerIdentityId: 'pi-test',
				kitSubscriberId: '4089521940',
				email: input.captured.contact.email!,
				occurredAt: '2026-05-15T12:02:00.000Z',
				journeyId,
			})
			const result = await click(input)
			expect(result.reviewReasons).toEqual([])
			expect(sendRows(input.repository)).toEqual([
				'ai-hero-skills-workflow.email-0',
				'ai-hero-skills-workflow.email-2',
			])
		},
	)

	it('defers the drip for a DOI-born contact with no owner record', async () => {
		const input = await legacyStarted()
		await doiBorn(input)
		const drip = await progressValuePathDrips({
			repository: input.repository,
			allowWrite: true,
			allowlist: input.allowlist,
			completedIntents: [completeEmail0(input)],
			now: '2026-05-16T12:06:00.000Z',
		})
		expect(drip.counts).toMatchObject({ planned: 0 })
		expect(drip.results[0]).toMatchObject({
			status: 'deferred',
			reviewReasons: ['drovr-owned'],
		})
		expect(sendRows(input.repository)).toEqual([
			'ai-hero-skills-workflow.email-0',
		])
	})

	it('records the quiz answer but plans no send for a drovr-owned contact', async () => {
		const input = await legacyStarted()
		await own(input)
		const result = await click(input)
		expect(result.status).toBe('recorded')
		expect(result.reviewReasons).toEqual(['drovr-owned'])
		expect(sendRows(input.repository)).toEqual([
			'ai-hero-skills-workflow.email-0',
		])
	})

	it('still plans the click send for a legacy-owned contact', async () => {
		const input = await legacyStarted()
		const result = await click(input)
		expect(result.status).toBe('recorded')
		expect(result.reviewReasons).toEqual([])
		expect(sendRows(input.repository)).toEqual([
			'ai-hero-skills-workflow.email-0',
			'ai-hero-skills-workflow.email-2',
		])
	})

	it('defers the drip for a drovr-owned contact instead of planning the next email', async () => {
		const input = await legacyStarted()
		await own(input)
		const email0 = Array.from(input.repository.sideEffectIntents.values()).find(
			(intent) =>
				intent.type === 'send-value-path-email' &&
				intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-0',
		)!
		input.repository.updateSideEffectIntent(email0.id, {
			status: 'completed',
			gates: email0.gates,
			reviewReasons: [],
			metadata: { ...email0.metadata, completedAt: '2026-05-15T12:06:00.000Z' },
		})
		const drip = await progressValuePathDrips({
			repository: input.repository,
			allowWrite: true,
			allowlist: input.allowlist,
			completedIntents: [input.repository.sideEffectIntents.get(email0.id)!],
			now: '2026-05-16T12:06:00.000Z',
		})
		expect(drip.counts).toMatchObject({ planned: 0 })
		expect(drip.results[0]).toMatchObject({
			status: 'deferred',
			reviewReasons: ['drovr-owned'],
		})
		expect(sendRows(input.repository)).toEqual([
			'ai-hero-skills-workflow.email-0',
		])
	})

	it('still plans the drip for a contact owned only for the newsletter', async () => {
		const input = await legacyStarted()
		await recordJourneyOwnerAssigned({
			repository: input.repository,
			contactId: input.captured.contact.id,
			providerIdentityId: 'pi-test',
			kitSubscriberId: '4089521940',
			email: input.captured.contact.email!,
			occurredAt: '2026-05-15T12:02:00.000Z',
			journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
		})
		const drip = await progressValuePathDrips({
			repository: input.repository,
			allowWrite: true,
			allowlist: input.allowlist,
			completedIntents: [completeEmail0(input)],
			now: '2026-05-16T12:06:00.000Z',
		})
		expect(drip.results[0]?.reviewReasons ?? []).not.toContain('drovr-owned')
	})
})
