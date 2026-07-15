import { describe, expect, it } from 'vitest'

import {
	codingWorkflowFixture,
	restrictedFixture,
	supportFixture,
} from '../__fixtures__/quick-question-fixtures'
import { captureFrontQuickQuestionCsv } from '../capture-front-quick-question-csv'
import { captureFrontQuickQuestion } from '../capture-quick-question'
import {
	linkAiHeroUserIdentities,
	linkKitSubscriberIdentities,
	previewContentReadContactEvent,
	previewContentReadContactEvents,
	previewShortlinkClickContactEvent,
	validateContentReadAllowWriteOptions,
	writeContentReadContactEvents,
} from '../contact-event-normalizer-preview'
import { renderContactEventReviewHtml } from '../contact-event-review-page'
import { DrizzleCaptureMarketingRepository } from '../drizzle-capture-repository'
import {
	dryRunSubscriberMarketingFixture,
	InMemorySubscriberMarketingRepository,
} from '../dry-run'
import { previewMatchedPurchaserValuePaths } from '../matched-purchaser-value-path-preview'
import { normalizeContactEvent } from '../normalize-contact-event'
import {
	InMemoryOperatorLookupRepository,
	lookupSubscriberMarketingContact,
	previewSubscriberMarketingReplay,
} from '../operator-lookup'
import { signValuePathToken, verifyValuePathToken } from '../path-token'
import { buildContactEventProductionReceipt } from '../production-receipt'
import {
	parseQuickQuestionAnalysisJsonForIdentity,
	parseQuickQuestionCsvForIdentity,
	previewPurchaseCorrelation,
	type PurchasePreviewRepository,
} from '../purchase-preview'
import { previewSeenContent } from '../seen-content'
import {
	SEEN_CONTENT_KIT_FIELD_KEYS,
	syncSeenContentKitFieldsForContactSnapshot,
	type KitSeenContentProvider,
} from '../seen-content-kit-sync'
import { previewShadowFieldCandidates } from '../shadow-field-candidates'
import {
	EXCLUDED_CTA_FIELD_KEYS,
	previewShadowFields,
	SHADOW_FIELD_KEYS,
} from '../shadow-field-planner'
import {
	syncShadowFieldsForContactSnapshot,
	type KitShadowFieldProvider,
} from '../shadow-field-sync'
import { classifyContactEvent } from '../signal-classifier'
import {
	buildTeamKitProjectionContacts,
	previewTeamKitProjection,
	type TeamKitProjectionProvider,
	type TeamPurchaseRow,
} from '../team-kit-projection'
import {
	MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT,
	verifyAnswerClickForStep,
} from '../value-path-answer-click-verification'
import { buildValuePathAskUrl } from '../value-path-answer-links'
import { parseValuePathAnswerPageResource } from '../value-path-answer-page'
import { recordValuePathAnswerProgression } from '../value-path-click-progression'
import {
	buildValuePathContentResourcePlan,
	importValuePathContentResources,
} from '../value-path-content-import'
import { previewValuePathContentImport } from '../value-path-content-import-preview'
import { progressValuePathDrips } from '../value-path-drip-progression'
import {
	classifyKitEnrollmentError,
	executePendingValuePathEmailIntents,
	executeValuePathEmailIntent,
} from '../value-path-email-executor'
import {
	evaluateGateDRuntimeAllowlist,
	gateDActivationObjectKey,
	gateDActivePointerKey,
	normalizeGateDRuntimeAllowlist,
	readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
	writeGateDRuntimeAllowlist,
} from '../value-path-gate-d-allowlist'
import { previewValuePathGateDCandidates } from '../value-path-gate-d-candidates'
import { startValuePathGateDActivation } from '../value-path-gate-d-start'
import { selectCompletedValuePathIntentFrontier } from '../value-path-intent-scan'
import { previewValuePath, SELLABLE_OFFERS } from '../value-path-planner'
import { previewSkillsWorkflowValuePathQa } from '../value-path-qa-preview'
import {
	evaluateValuePathMovement,
	resolveGateDRunState,
} from '../value-path-run-state'
import {
	applyAcceptedValuePathSendGateReviewReasons,
	evaluateValuePathEmailSendGate,
} from '../value-path-send-gate'

class InMemoryRedis {
	store = new Map<string, unknown>()

	get<T = unknown>(key: string) {
		return (this.store.get(key) as T | undefined) ?? null
	}

	set(key: string, value: unknown) {
		this.store.set(key, value)
		return 'OK'
	}
}

describe('subscriber marketing Gate D allowlist', () => {
	it('previews recent Skills QQ candidates with redacted identity and blockers', () => {
		const preview = previewValuePathGateDCandidates({
			now: '2026-05-14T12:00:00.000Z',
			recentDays: 14,
			targetCount: 2,
			skillsFormSubscribers: [
				{
					kitSubscriberId: '4111',
					email: 'Friendly@Example.com',
					subscribedAt: '2026-05-12T09:00:00.000Z',
					scheduleEvidence: {
						timezone: 'America/New_York',
						source: 'browser',
					},
				},
				{
					kitSubscriberId: '4222',
					email: 'support@example.com',
					subscribedAt: '2026-05-12T09:00:00.000Z',
				},
			],
			quickQuestionReplies: [
				{
					contactId: 'contact_1',
					email: 'friendly@example.com',
					occurredAt: '2026-05-13T09:00:00.000Z',
					reviewSignals: [],
				},
				{
					contactId: 'contact_2',
					email: 'support@example.com',
					occurredAt: '2026-05-13T09:00:00.000Z',
					reviewSignals: ['support'],
				},
			],
		})

		expect(preview.counts.candidates).toBe(1)
		expect(preview.candidates[0]).toMatchObject({
			redactedEmail: 'f***@example.com',
			contactId: 'contact_1',
			kitSubscriberId: '4111',
			domain: 'example.com',
			rationale: ['skills-form', 'quick-question-reply'],
			blockers: [],
			sourceEvidence: {
				skillsForm: true,
				quickQuestionReply: true,
			},
		})
		expect(preview.candidates[0]?.emailHash).toMatch(/^sha256:/)
		expect(preview.blocked[0]).toMatchObject({
			contactId: 'contact_2',
			blockers: ['support-intent'],
		})
		expect(preview.warnings).toContain('candidate-count-below-target:1:2')
	})

	it('writes and reads an active Upstash Redis Gate D allowlist object', async () => {
		const redis = new InMemoryRedis()
		const allowlist = await writeGateDRuntimeAllowlist({
			redis,
			activate: true,
			allowlist: {
				activationId: 'skills-workflow:2026-05-14-a',
				status: 'active',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow'],
				contactIds: [],
				kitSubscriberIds: [],
				emails: [],
				emailHashes: [],
				emailResourceIds: ['ai-hero-skills-workflow.email-0'],
				kitSequenceIds: ['2757199'],
				candidates: [
					{
						contactId: 'contact_1',
						kitSubscriberId: '4111',
						email: 'Friendly@Example.com',
						rationale: ['skills-form', 'quick-question-reply'],
						blockers: [],
					},
				],
				createdAt: '2026-05-14T12:00:00.000Z',
			},
		})

		expect(redis.get(gateDActivePointerKey())).toBe(
			'skills-workflow:2026-05-14-a',
		)
		expect(redis.get(gateDActivationObjectKey(allowlist.activationId))).toEqual(
			allowlist,
		)
		const read = await readActiveGateDRuntimeAllowlist({ redis })
		expect(read.passed).toBe(true)
		expect(read.allowlist?.emails).toEqual(['friendly@example.com'])
		expect(read.allowlist?.emailHashes[0]).toMatch(/^sha256:/)
	})

	it('normalizes active Gate D allowlists as finish-approved path authorizations', () => {
		const allowlist = normalizeGateDRuntimeAllowlist({
			activationId: 'skills-workflow:authorization-test',
			status: 'active',
			killSwitch: false,
			mode: 'allowlisted-test',
			pathSlugs: ['ai-hero-skills-workflow'],
			contactIds: ['contact_1'],
			kitSubscriberIds: ['4111'],
			emails: ['friendly@example.com'],
			emailHashes: [],
			emailResourceIds: ['ai-hero-skills-workflow.email-0'],
			kitSequenceIds: ['2757199'],
			candidates: [],
			createdAt: '2026-05-14T12:00:00.000Z',
		})

		expect(allowlist).toMatchObject({
			authorizationMode: 'finish-approved-path',
			preAuthorizedReviewReasons: ['human-review'],
			retryPolicy: {
				providerRetryDelayMinutes: 15,
				maxProviderRetryAttempts: 5,
			},
			maxSendsPerRun: 25,
		})
		expect(allowlist.allowedActions).toEqual(
			expect.arrayContaining([
				'send-path-emails',
				'advance-by-answer-click',
				'advance-by-daily-drip',
				'retry-transient-provider-failures',
				'finish-full-approved-path',
			]),
		)
		expect(allowlist.stopFor).toEqual(
			expect.arrayContaining([
				'support-intent',
				'team-sales-intent',
				'path-token-secret-missing',
			]),
		)
	})

	it('evaluates runtime allowlists fail closed', async () => {
		const missing = await readActiveGateDRuntimeAllowlist({
			redis: new InMemoryRedis(),
		})
		expect(missing).toMatchObject({
			passed: false,
			reviewReasons: ['gate-d-allowlist-missing'],
		})

		const paused = evaluateGateDRuntimeAllowlist({
			allowlist: {
				activationId: 'paused',
				status: 'paused',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow'],
				contactIds: ['contact_1'],
				kitSubscriberIds: ['4111'],
				emails: ['friendly@example.com'],
				emailHashes: [],
				emailResourceIds: ['ai-hero-skills-workflow.email-0'],
				kitSequenceIds: ['2757199'],
				candidates: [],
				createdAt: '2026-05-14T12:00:00.000Z',
			},
			contactId: 'contact_1',
			kitSubscriberId: '4111',
			email: 'friendly@example.com',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			kitSequenceId: '2757199',
		})
		expect(paused).toMatchObject({
			passed: false,
			reviewReasons: ['gate-d-allowlist-paused'],
		})
	})

	it('requires every runtime dimension to be allowlisted', () => {
		const decision = evaluateGateDRuntimeAllowlist({
			allowlist: {
				activationId: 'active',
				status: 'active',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow'],
				contactIds: ['contact_1'],
				kitSubscriberIds: ['4111'],
				emails: ['friendly@example.com'],
				emailHashes: [],
				emailResourceIds: ['ai-hero-skills-workflow.email-0'],
				kitSequenceIds: ['2757199'],
				candidates: [],
				createdAt: '2026-05-14T12:00:00.000Z',
			},
			contactId: 'contact_1',
			kitSubscriberId: '4111',
			email: 'friendly@example.com',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			kitSequenceId: '2757199',
		})
		expect(decision).toMatchObject({
			passed: true,
			reviewReasons: [],
		})

		const blocked = evaluateGateDRuntimeAllowlist({
			allowlist: decision.allowlist!,
			contactId: 'contact_2',
			kitSubscriberId: '4222',
			email: 'other@example.com',
			valuePathSlug: 'other-path',
			emailResourceId: 'other.email-0',
			kitSequenceId: '999',
		})
		expect(blocked.reviewReasons).toEqual([
			'contact-not-allowlisted',
			'kit-subscriber-not-allowlisted',
			'email-not-allowlisted',
			'value-path-not-allowlisted',
			'email-resource-not-allowlisted',
			'kit-sequence-not-allowlisted',
		])
	})

	it('starts Gate D by creating only Email 0 receipts and pending Kit intents', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-15T12:00:00.000Z',
		})
		const result = await startValuePathGateDActivation({
			repository,
			allowWrite: true,
			allowlist: {
				activationId: 'rig-test-2026-05-15-a',
				status: 'active',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow'],
				contactIds: [captured.contact.id],
				kitSubscriberIds: ['4089521940'],
				emails: [captured.contact.email!],
				emailHashes: [],
				emailResourceIds: ['ai-hero-skills-workflow.email-0'],
				kitSequenceIds: ['2757199'],
				candidates: [
					{
						contactId: captured.contact.id,
						kitSubscriberId: '4089521940',
						email: captured.contact.email!,
						rationale: ['skills-form', 'quick-question-reply'],
						blockers: [],
					},
				],
				createdAt: '2026-05-15T12:00:00.000Z',
			},
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			kitSequenceId: '2757199',
			acceptedReviewReasons: ['human-review'],
			now: '2026-05-15T12:05:00.000Z',
		})

		expect(result.counts).toMatchObject({
			candidates: 1,
			planned: 1,
			created: 1,
		})
		expect(
			Array.from(repository.contactEvents.values()).find(
				(event) => event.eventType === 'value-path.entered',
			),
		).toMatchObject({
			semanticIdempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:start:ai-hero-skills-workflow.email-0`,
		})
		expect(
			Array.from(repository.sideEffectIntents.values()).filter(
				(intent) => intent.type === 'send-value-path-email',
			),
		).toHaveLength(1)
		expect(
			Array.from(repository.sideEffectIntents.values()).find(
				(intent) => intent.type === 'send-value-path-email',
			),
		).toMatchObject({
			status: 'pending',
			metadata: {
				activationId: 'rig-test-2026-05-15-a',
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
			},
		})
	})

	it('lets an active finish-approved path authorization cover start, answer click, and drip without fresh flags', async () => {
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

		const click = await recordValuePathAnswerProgression({
			repository,
			token: {
				contactId: captured.contact.id,
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
			mode: allowlist.mode,
			sendGate: {
				allowedActions: allowlist.allowedActions,
				allowlistedContactIds: allowlist.contactIds,
				allowlistedKitSubscriberIds: allowlist.kitSubscriberIds,
				allowlistedEmails: allowlist.emails,
				enabledValuePathSlugs: allowlist.pathSlugs,
				verifiedEmailResourceIds: allowlist.emailResourceIds,
				verifiedKitSequenceIds: allowlist.kitSequenceIds,
			},
			acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
				allowlist,
			}),
			now: '2026-05-15T12:10:00.000Z',
		})
		expect(click.status).toBe('recorded')
		expect(click.reviewReasons).toEqual([])

		const email0Intent = Array.from(repository.sideEffectIntents.values()).find(
			(intent) =>
				intent.type === 'send-value-path-email' &&
				intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-0',
		)!
		repository.updateSideEffectIntent(email0Intent.id, {
			status: 'completed',
			gates: email0Intent.gates,
			reviewReasons: [],
			metadata: {
				...email0Intent.metadata,
				completedAt: '2026-05-15T12:06:00.000Z',
			},
		})
		const drip = await progressValuePathDrips({
			repository,
			allowWrite: true,
			allowlist,
			completedIntents: [repository.sideEffectIntents.get(email0Intent.id)!],
			now: '2026-05-16T12:06:00.000Z',
		})
		expect(drip.counts).toMatchObject({ planned: 1, blocked: 0 })
	})

	it('drip progresses no-click Email 0 completion to the next one-email sequence', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-15T12:00:00.000Z',
		})
		const allowlist = {
			activationId: 'rig-test-2026-05-15-a',
			status: 'active' as const,
			killSwitch: false,
			mode: 'allowlisted-test' as const,
			pathSlugs: ['ai-hero-skills-workflow'],
			contactIds: [captured.contact.id],
			kitSubscriberIds: ['4089521940'],
			emails: [captured.contact.email!],
			emailHashes: [],
			emailResourceIds: [
				'ai-hero-skills-workflow.email-0',
				'ai-hero-skills-workflow.email-1',
			],
			kitSequenceIds: ['2757199', '2757200'],
			candidates: [
				{
					contactId: captured.contact.id,
					kitSubscriberId: '4089521940',
					email: captured.contact.email!,
					rationale: ['skills-form', 'quick-question-reply'],
					blockers: [],
				},
			],
			createdAt: '2026-05-15T12:00:00.000Z',
		}
		await startValuePathGateDActivation({
			repository,
			allowWrite: true,
			allowlist,
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			kitSequenceId: '2757199',
			acceptedReviewReasons: ['human-review'],
			now: '2026-05-15T12:05:00.000Z',
		})
		const email0Intent = Array.from(repository.sideEffectIntents.values()).find(
			(intent) =>
				intent.type === 'send-value-path-email' &&
				intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-0',
		)!
		repository.updateSideEffectIntent(email0Intent.id, {
			status: 'completed',
			gates: email0Intent.gates,
			reviewReasons: [],
			metadata: {
				...email0Intent.metadata,
				completedAt: '2026-05-15T12:06:00.000Z',
			},
		})

		const result = await progressValuePathDrips({
			repository,
			allowWrite: true,
			allowlist,
			completedIntents: repository.findCompletedValuePathEmailSideEffectIntents(
				{ limit: 10 },
			),
			acceptedReviewReasons: ['human-review'],
			now: '2026-05-16T12:06:00.000Z',
		})

		expect(result.counts).toMatchObject({ planned: 1, blocked: 0 })
		expect(
			Array.from(repository.contactEvents.values()).find(
				(event) => event.eventType === 'value-path.drip-progressed',
			),
		).toMatchObject({
			semanticIdempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:drip:ai-hero-skills-workflow.email-0`,
		})
		expect(
			Array.from(repository.sideEffectIntents.values()).find(
				(intent) =>
					intent.type === 'send-value-path-email' &&
					intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-1',
			),
		).toMatchObject({
			status: 'pending',
			metadata: {
				progression: 'daily-drip',
				kitSequenceId: '2757200',
			},
		})
	})

	it('blocks drip progression when authorization omits the daily drip action', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		const completedIntent = repository.createSideEffectIntent({
			id: 'intent_email_0_no_drip_action',
			nextActionId: 'next_action_0',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'completed',
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0`,
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				kitSubscriberId: '4089521940',
				completedAt: '2026-05-15T12:06:00.000Z',
			},
			createdAt: '2026-05-15T12:05:00.000Z',
		})
		const result = await progressValuePathDrips({
			repository,
			allowWrite: true,
			allowlist: normalizeGateDRuntimeAllowlist({
				activationId: 'rig-test-no-drip-action',
				status: 'active',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow'],
				contactIds: [captured.contact.id],
				kitSubscriberIds: ['4089521940'],
				emails: [captured.contact.email!],
				emailHashes: [],
				emailResourceIds: [
					'ai-hero-skills-workflow.email-0',
					'ai-hero-skills-workflow.email-1',
				],
				kitSequenceIds: ['2757199', '2757200'],
				candidates: [],
				allowedActions: ['send-path-emails'],
				createdAt: '2026-05-15T12:00:00.000Z',
			}),
			completedIntents: [completedIntent],
			now: '2026-05-16T12:06:00.000Z',
		})

		expect(result.counts).toMatchObject({ planned: 0, blocked: 1 })
		expect(result.results[0]?.reviewReasons).toContain(
			'authorization-action-not-allowed:advance-by-daily-drip',
		)
	})

	it('does not duplicate drip progression when click progression already created the next intent', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		const completedIntent = repository.createSideEffectIntent({
			id: 'intent_email_0',
			nextActionId: 'next_action_0',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'completed',
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0`,
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				kitSubscriberId: '4089521940',
				completedAt: '2026-05-15T12:06:00.000Z',
			},
			createdAt: '2026-05-15T12:05:00.000Z',
		})
		repository.createSideEffectIntent({
			id: 'intent_email_1_from_click',
			nextActionId: 'next_action_1',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'pending',
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-1`,
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				kitSequenceId: '2757200',
				progression: 'answer-click',
			},
			createdAt: '2026-05-15T12:10:00.000Z',
		})

		const result = await progressValuePathDrips({
			repository,
			allowWrite: true,
			allowlist: {
				activationId: 'rig-test-2026-05-15-a',
				status: 'active',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow'],
				contactIds: [captured.contact.id],
				kitSubscriberIds: ['4089521940'],
				emails: [captured.contact.email!],
				emailHashes: [],
				emailResourceIds: [
					'ai-hero-skills-workflow.email-0',
					'ai-hero-skills-workflow.email-1',
				],
				kitSequenceIds: ['2757199', '2757200'],
				candidates: [],
				createdAt: '2026-05-15T12:00:00.000Z',
			},
			completedIntents: [completedIntent],
			acceptedReviewReasons: ['human-review'],
			now: '2026-05-16T12:06:00.000Z',
		})

		expect(result.counts.idempotentNoop).toBe(1)
		expect(
			Array.from(repository.sideEffectIntents.values()).filter(
				(intent) =>
					intent.type === 'send-value-path-email' &&
					intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-1',
			),
		).toHaveLength(1)
	})

	it('does not default-drip Email 0 after an answer click routes to a different branch', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		const completedIntent = repository.createSideEffectIntent({
			id: 'intent_email_0',
			nextActionId: 'next_action_0',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'completed',
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0`,
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				kitSubscriberId: '4089521940',
				completedAt: '2026-05-15T12:06:00.000Z',
			},
			createdAt: '2026-05-15T12:05:00.000Z',
		})
		repository.createContactEvent({
			contactId: captured.contact.id,
			providerIdentityId: captured.providerIdentity.id,
			provider: 'ai-hero',
			providerEventId: 'answer-team',
			providerReference: '/ask/team-email-1',
			eventType: 'value-path.answer-selected',
			occurredAt: '2026-05-15T12:10:00.000Z',
			semanticIdempotencyKey: 'answer-team',
			privacyLevel: 'internal',
			identityEvidence: captured.providerIdentity.evidence,
			payloadSummary: {
				summary: 'Selected answer team for email-0-path-survey',
				keywords: [
					'value-path',
					'answer-selected',
					'ai-hero-skills-workflow',
					'team',
				],
				restrictedPayloadStored: false,
			},
			schemaVersion: 1,
			createdAt: '2026-05-15T12:10:00.000Z',
		})
		repository.createSideEffectIntent({
			id: 'intent_team_email_1_from_click',
			nextActionId: 'next_action_click_team',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'pending',
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-team-workflow:email:ai-hero-skills-team-workflow.team-email-1`,
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-team-workflow',
				emailResourceId: 'ai-hero-skills-team-workflow.team-email-1',
				kitSequenceId: '2757207',
				progression: 'answer-click',
			},
			createdAt: '2026-05-15T12:10:00.000Z',
		})

		const result = await progressValuePathDrips({
			repository,
			allowWrite: true,
			allowlist: {
				activationId: 'rig-test-2026-05-15-a',
				status: 'active',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow', 'ai-hero-skills-team-workflow'],
				contactIds: [captured.contact.id],
				kitSubscriberIds: ['4089521940'],
				emails: [captured.contact.email!],
				emailHashes: [],
				emailResourceIds: [
					'ai-hero-skills-workflow.email-0',
					'ai-hero-skills-workflow.email-1',
					'ai-hero-skills-team-workflow.team-email-1',
				],
				kitSequenceIds: ['2757199', '2757200', '2757207'],
				candidates: [],
				createdAt: '2026-05-15T12:00:00.000Z',
			},
			completedIntents: [completedIntent],
			acceptedReviewReasons: ['human-review'],
			now: '2026-05-16T12:06:00.000Z',
		})

		expect(result.counts.idempotentNoop).toBe(1)
		expect(result.results[0]?.reviewReasons).toContain(
			'answer-click-already-selected',
		)
		expect(
			Array.from(repository.sideEffectIntents.values()).filter(
				(intent) =>
					intent.type === 'send-value-path-email' &&
					intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-1',
			),
		).toHaveLength(0)
	})

	it('drips the default next email when an answer click never produced a deliverable intent', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		const completedIntent = repository.createSideEffectIntent({
			id: 'intent_email_0',
			nextActionId: 'next_action_0',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'completed',
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0`,
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				kitSubscriberId: '4089521940',
				completedAt: '2026-05-15T12:06:00.000Z',
			},
			createdAt: '2026-05-15T12:05:00.000Z',
		})
		repository.createContactEvent({
			contactId: captured.contact.id,
			providerIdentityId: captured.providerIdentity.id,
			provider: 'ai-hero',
			providerEventId: 'answer-team-undelivered',
			providerReference: '/ask/team-email-1',
			eventType: 'value-path.answer-selected',
			occurredAt: '2026-05-15T12:10:00.000Z',
			semanticIdempotencyKey: 'answer-team-undelivered',
			privacyLevel: 'internal',
			identityEvidence: captured.providerIdentity.evidence,
			payloadSummary: {
				summary: 'Selected answer team for email-0-path-survey',
				keywords: [
					'value-path',
					'answer-selected',
					'ai-hero-skills-workflow',
					'team',
				],
				restrictedPayloadStored: false,
			},
			schemaVersion: 1,
			createdAt: '2026-05-15T12:10:00.000Z',
		})
		// The click ran in dry-run mode, so its intent can never be delivered.
		repository.createSideEffectIntent({
			id: 'intent_team_email_1_dry_run_click',
			nextActionId: 'next_action_click_team',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'dry-run',
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-team-workflow:email:ai-hero-skills-team-workflow.team-email-1`,
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-team-workflow',
				emailResourceId: 'ai-hero-skills-team-workflow.team-email-1',
				kitSequenceId: '2757207',
				progression: 'answer-click',
			},
			createdAt: '2026-05-15T12:10:00.000Z',
		})

		const result = await progressValuePathDrips({
			repository,
			allowWrite: true,
			allowlist: {
				activationId: 'rig-test-2026-05-15-a',
				status: 'active',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow', 'ai-hero-skills-team-workflow'],
				contactIds: [captured.contact.id],
				kitSubscriberIds: ['4089521940'],
				emails: [captured.contact.email!],
				emailHashes: [],
				emailResourceIds: [
					'ai-hero-skills-workflow.email-0',
					'ai-hero-skills-workflow.email-1',
					'ai-hero-skills-team-workflow.team-email-1',
				],
				kitSequenceIds: ['2757199', '2757200', '2757207'],
				candidates: [],
				createdAt: '2026-05-15T12:00:00.000Z',
			},
			completedIntents: [completedIntent],
			acceptedReviewReasons: ['human-review'],
			now: '2026-05-16T12:06:00.000Z',
		})

		expect(result.counts).toMatchObject({ planned: 1, idempotentNoop: 0 })
		expect(result.results[0]?.advisoryReasons).toContain(
			'answer-click-undelivered-drip-fallback',
		)
		expect(
			Array.from(repository.sideEffectIntents.values()).find(
				(intent) =>
					intent.type === 'send-value-path-email' &&
					intent.metadata.emailResourceId === 'ai-hero-skills-workflow.email-1',
			),
		).toMatchObject({ status: 'pending' })
	})

	it('does not park the drip on scanner-volume answer clicks', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		const completedIntent = repository.createSideEffectIntent({
			id: 'intent_email_0',
			nextActionId: 'next_action_0',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'completed',
			idempotencyKey: `contact:${captured.contact.id}:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0`,
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				kitSequenceId: '2757199',
				kitSubscriberId: '4089521940',
				completedAt: '2026-05-15T12:06:00.000Z',
			},
			createdAt: '2026-05-15T12:05:00.000Z',
		})
		// Security-scanner signature: far more answer clicks than emails exist.
		for (let index = 0; index < 20; index++) {
			repository.createContactEvent({
				contactId: captured.contact.id,
				providerIdentityId: captured.providerIdentity.id,
				provider: 'ai-hero',
				providerEventId: `scanner-click-${index}`,
				providerReference: `/ask/option-${index}`,
				eventType: 'value-path.answer-selected',
				occurredAt: '2026-05-15T12:07:00.000Z',
				semanticIdempotencyKey: `scanner-click-${index}`,
				privacyLevel: 'internal',
				identityEvidence: captured.providerIdentity.evidence,
				payloadSummary: {
					summary: `Selected answer option-${index} for email-0-path-survey`,
					keywords: ['value-path', 'answer-selected'],
					restrictedPayloadStored: false,
				},
				schemaVersion: 1,
				createdAt: '2026-05-15T12:07:00.000Z',
			})
		}

		const result = await progressValuePathDrips({
			repository,
			allowWrite: true,
			allowlist: {
				activationId: 'rig-test-2026-05-15-a',
				status: 'active',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow'],
				contactIds: [captured.contact.id],
				kitSubscriberIds: ['4089521940'],
				emails: [captured.contact.email!],
				emailHashes: [],
				emailResourceIds: [
					'ai-hero-skills-workflow.email-0',
					'ai-hero-skills-workflow.email-1',
				],
				kitSequenceIds: ['2757199', '2757200'],
				candidates: [],
				createdAt: '2026-05-15T12:00:00.000Z',
			},
			completedIntents: [completedIntent],
			acceptedReviewReasons: ['human-review'],
			now: '2026-05-16T12:06:00.000Z',
		})

		expect(result.counts).toMatchObject({ planned: 1, idempotentNoop: 0 })
		expect(result.results[0]?.advisoryReasons).toContain(
			'answer-click-unverified:implausible-contact-volume',
		)
	})

	it('blocks Gate D start when the Email 0 sequence is not allowlisted', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		const result = await startValuePathGateDActivation({
			repository,
			allowWrite: true,
			allowlist: {
				activationId: 'rig-test-2026-05-15-a',
				status: 'active',
				killSwitch: false,
				mode: 'allowlisted-test',
				pathSlugs: ['ai-hero-skills-workflow'],
				contactIds: [captured.contact.id],
				kitSubscriberIds: ['4089521940'],
				emails: [captured.contact.email!],
				emailHashes: [],
				emailResourceIds: ['ai-hero-skills-workflow.email-0'],
				kitSequenceIds: ['2757200'],
				candidates: [
					{
						contactId: captured.contact.id,
						kitSubscriberId: '4089521940',
						email: captured.contact.email!,
						rationale: ['skills-form', 'quick-question-reply'],
						blockers: [],
					},
				],
				createdAt: '2026-05-15T12:00:00.000Z',
			},
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			kitSequenceId: '2757199',
			acceptedReviewReasons: ['human-review'],
		})

		expect(result.counts.blocked).toBe(1)
		expect(result.results[0]?.reviewReasons).toContain(
			'kit-sequence-not-allowlisted',
		)
		expect(
			Array.from(repository.sideEffectIntents.values()).filter(
				(intent) => intent.type === 'send-value-path-email',
			),
		).toHaveLength(0)
	})
})

describe('subscriber marketing value path completed-intent scan', () => {
	function completedIntent(args: {
		id: string
		contactId: string
		emailResourceId: string
		completedAt: string
		valuePathSlug?: string
	}) {
		return {
			id: args.id,
			nextActionId: `next_action_${args.id}`,
			contactId: args.contactId,
			provider: 'kit' as const,
			type: 'send-value-path-email' as const,
			status: 'completed' as const,
			idempotencyKey: `contact:${args.contactId}:value-path:${args.valuePathSlug ?? 'ai-hero-skills-workflow'}:email:${args.emailResourceId}`,
			gates: [],
			reviewReasons: [],
			metadata: {
				valuePathSlug: args.valuePathSlug ?? 'ai-hero-skills-workflow',
				emailResourceId: args.emailResourceId,
				completedAt: args.completedAt,
			},
			createdAt: args.completedAt,
		}
	}

	it('reduces the scan to each contact/path frontier ordered oldest first', () => {
		const intents = [
			completedIntent({
				id: 'a_email_0',
				contactId: 'contact-a',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				completedAt: '2026-05-01T00:00:00.000Z',
			}),
			completedIntent({
				id: 'a_email_1',
				contactId: 'contact-a',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				completedAt: '2026-05-03T00:00:00.000Z',
			}),
			completedIntent({
				id: 'b_email_0',
				contactId: 'contact-b',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				completedAt: '2026-05-02T00:00:00.000Z',
			}),
		]
		const result = selectCompletedValuePathIntentFrontier({
			intents,
			limit: 200,
		})
		expect(result.map((intent) => intent.id)).toEqual(['b_email_0', 'a_email_1'])
	})

	it('still honors maxCompletedAt for the minimum drip age', () => {
		const result = selectCompletedValuePathIntentFrontier({
			intents: [
				completedIntent({
					id: 'too_recent',
					contactId: 'contact-a',
					emailResourceId: 'ai-hero-skills-workflow.email-1',
					completedAt: '2026-05-16T00:00:00.000Z',
				}),
				completedIntent({
					id: 'old_enough',
					contactId: 'contact-a',
					emailResourceId: 'ai-hero-skills-workflow.email-0',
					completedAt: '2026-05-01T00:00:00.000Z',
				}),
			],
			limit: 200,
			maxCompletedAt: '2026-05-15T00:00:00.000Z',
		})
		expect(result.map((intent) => intent.id)).toEqual(['old_enough'])
	})

	it('reaches a starved contact frontier even when history exceeds the scan limit', async () => {
		// Regression: 2026-05 cohort stall. The completed-intent history grew
		// past the 200-row scan window and the hourly drip cron rescanned the
		// same saturated window forever, never reaching the frontier.
		const rows: Record<string, unknown>[] = []
		for (let index = 0; index < 205; index++) {
			rows.push(
				completedIntent({
					id: `noise_${index}`,
					contactId: `noise-contact-${index}`,
					emailResourceId: 'ai-hero-skills-workflow.email-0',
					completedAt: `2026-05-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
				}),
			)
		}
		// The starved contact sits past the old 200-row window in table order,
		// with the oldest frontier of all — exactly the contact the scan lost.
		rows.push(
			completedIntent({
				id: 'stalled_email_0',
				contactId: 'contact-stalled',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				completedAt: '2026-04-29T00:00:00.000Z',
			}),
			completedIntent({
				id: 'stalled_email_1',
				contactId: 'contact-stalled',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				completedAt: '2026-04-30T00:00:00.000Z',
			}),
		)
		const database = {
			select: () => ({ from: () => ({ where: async () => rows }) }),
		}
		const repository = new DrizzleCaptureMarketingRepository(database)
		const result =
			await repository.findCompletedValuePathEmailSideEffectIntents({
				limit: 200,
			})
		expect(result).toHaveLength(200)
		expect(result[0]).toMatchObject({
			contactId: 'contact-stalled',
			id: 'stalled_email_1',
		})
		expect(
			result.filter((intent) => intent.contactId === 'contact-stalled'),
		).toHaveLength(1)
	})
})

describe('subscriber marketing value path run state', () => {
	it('reads as stalled when mid-path participants have had no movement past the threshold', () => {
		const movement = evaluateValuePathMovement({
			intents: [
				{
					createdAt: '2026-05-29T00:00:00.000Z',
					metadata: { completedAt: '2026-05-30T00:00:00.000Z' },
				},
			],
			events: [
				{
					eventType: 'value-path.drip-progressed',
					occurredAt: '2026-05-30T00:00:00.000Z',
				},
			],
			participants: 100,
			completedPathCount: 10,
			now: '2026-07-14T00:00:00.000Z',
		})
		expect(movement.stalled).toBe(true)
		expect(movement.midPathParticipants).toBe(90)
		expect(movement.lastMovementAt).toBe('2026-05-30T00:00:00.000Z')

		const runState = resolveGateDRunState({
			authorizationPassed: true,
			authorizationReviewReasons: [],
			hardBlockerCount: 0,
			retryableDue: 0,
			retryableWaiting: 0,
			pending: 0,
			dueSends: 0,
			participants: 100,
			completedPathCount: 10,
			movement,
		})
		expect(runState.state).toBe('stalled')
		expect(runState.plainLanguage).toContain('STALLED')
		expect(runState.plainLanguage).toContain('90')
	})

	it('reads as running when due sends exist even with stale movement', () => {
		const movement = evaluateValuePathMovement({
			intents: [
				{
					createdAt: '2026-05-29T00:00:00.000Z',
					metadata: { completedAt: '2026-05-30T00:00:00.000Z' },
				},
			],
			events: [],
			participants: 100,
			completedPathCount: 10,
			now: '2026-07-14T00:00:00.000Z',
		})
		const runState = resolveGateDRunState({
			authorizationPassed: true,
			authorizationReviewReasons: [],
			hardBlockerCount: 0,
			retryableDue: 0,
			retryableWaiting: 0,
			pending: 0,
			dueSends: 12,
			participants: 100,
			completedPathCount: 10,
			movement,
		})
		expect(runState.state).toBe('running')
	})

	it('reads as waiting when movement is recent', () => {
		const movement = evaluateValuePathMovement({
			intents: [
				{
					createdAt: '2026-07-13T20:00:00.000Z',
					metadata: { completedAt: '2026-07-13T22:00:00.000Z' },
				},
			],
			events: [],
			participants: 100,
			completedPathCount: 10,
			now: '2026-07-14T00:00:00.000Z',
		})
		expect(movement.stalled).toBe(false)
		const runState = resolveGateDRunState({
			authorizationPassed: true,
			authorizationReviewReasons: [],
			hardBlockerCount: 0,
			retryableDue: 0,
			retryableWaiting: 0,
			pending: 0,
			dueSends: 0,
			participants: 100,
			completedPathCount: 10,
			movement,
		})
		expect(runState.state).toBe('waiting')
	})

	it('reads as completed when every participant reached a terminal email', () => {
		const movement = evaluateValuePathMovement({
			intents: [
				{
					createdAt: '2026-05-29T00:00:00.000Z',
					metadata: { completedAt: '2026-05-30T00:00:00.000Z' },
				},
			],
			events: [],
			participants: 5,
			completedPathCount: 5,
			now: '2026-07-14T00:00:00.000Z',
		})
		expect(movement.stalled).toBe(false)
		const runState = resolveGateDRunState({
			authorizationPassed: true,
			authorizationReviewReasons: [],
			hardBlockerCount: 0,
			retryableDue: 0,
			retryableWaiting: 0,
			pending: 0,
			dueSends: 0,
			participants: 5,
			completedPathCount: 5,
			movement,
		})
		expect(runState.state).toBe('completed')
	})
})

describe('subscriber marketing answer click verification', () => {
	const clickEvent = (summary: string, occurredAt = '2026-05-15T12:07:00.000Z') => ({
		occurredAt,
		payloadSummary: {
			summary,
			keywords: [],
			restrictedPayloadStored: false as const,
		},
	})

	it('verifies a single organic click for the step', () => {
		const result = verifyAnswerClickForStep({
			events: [clickEvent('Selected answer correct for email-0-path-survey')],
			emailStepId: 'email-0',
		})
		expect(result.verdict).toBe('verified')
	})

	it('rejects contacts past the organic click ceiling', () => {
		const events = Array.from(
			{ length: MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT + 1 },
			(_, index) =>
				clickEvent(`Selected answer option-${index} for email-0-path-survey`),
		)
		const result = verifyAnswerClickForStep({ events, emailStepId: 'email-0' })
		expect(result.verdict).toBe('implausible-contact-volume')
	})

	it('rejects several distinct selections for the same step', () => {
		const result = verifyAnswerClickForStep({
			events: [
				clickEvent('Selected answer a for email-0-path-survey'),
				clickEvent('Selected answer b for email-0-path-survey'),
				clickEvent('Selected answer c for email-0-path-survey'),
			],
			emailStepId: 'email-0',
		})
		expect(result.verdict).toBe('implausible-step-volume')
	})
})

describe('subscriber marketing value path click progression', () => {
	function makeAnswerPage(overrides: Record<string, unknown> = {}) {
		return parseValuePathAnswerPageResource({
			id: 'answer_123',
			type: 'value-path-page',
			fields: {
				kind: 'answer',
				slug: 'skills-workflow-email-1-correct',
				surveyId: 'email-1.quiz',
				optionValue: 'correct',
				nextEmailId: 'email-2',
				nextEmailResourceId: 'ai-hero-skills-workflow.email-2',
				...overrides,
			},
		})!
	}

	async function makeProgressionFixture() {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-14T11:00:00.000Z',
		})
		return { repository, captured }
	}

	it('records answer click Contact Event, NextAction, and dry-run SideEffectIntent', async () => {
		const { repository, captured } = await makeProgressionFixture()
		const result = await recordValuePathAnswerProgression({
			repository,
			token: {
				contactId: captured.contact.id,
				kitSubscriberId: 'kit_123',
				valuePathResourceId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				sequenceId: 'ai-hero-skills-workflow',
				expiresAt: '2026-05-14T12:00:00.000Z',
			},
			answerPage: makeAnswerPage(),
			now: '2026-05-14T11:05:00.000Z',
		})

		expect(result.status).toBe('recorded')
		expect(
			Array.from(repository.contactEvents.values()).find(
				(event) => event.eventType === 'value-path.answer-selected',
			),
		).toMatchObject({ provider: 'ai-hero' })
		expect(
			Array.from(repository.nextActions.values()).find(
				(action) => action.type === 'advance-value-path',
			),
		).toMatchObject({ status: 'blocked' })
		expect(
			Array.from(repository.nextActions.values()).find(
				(action) => action.type === 'advance-value-path',
			)?.reviewReasons,
		).toEqual(expect.arrayContaining(['mode-dry-run']))
		expect(
			Array.from(repository.sideEffectIntents.values()).find(
				(intent) => intent.type === 'send-value-path-email',
			),
		).toMatchObject({
			provider: 'kit',
			status: 'dry-run',
			idempotencyKey:
				'contact:fixture_contact_1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-2',
			metadata: {
				gate: 'send-gate-d-value-path-email',
				mode: 'dry-run',
				providerResult: null,
			},
		})
	})

	it('creates a pending Kit intent for allowlisted-test progression', async () => {
		const { repository, captured } = await makeProgressionFixture()
		const result = await recordValuePathAnswerProgression({
			repository,
			token: {
				contactId: captured.contact.id,
				kitSubscriberId: 'kit_123',
				valuePathResourceId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				sequenceId: 'ai-hero-skills-workflow',
				expiresAt: '2026-05-14T12:00:00.000Z',
			},
			answerPage: makeAnswerPage({ kitSequenceId: '2757201' }),
			mode: 'allowlisted-test',
			sendGate: { allowlistedContactIds: [captured.contact.id] },
			now: '2026-05-14T11:05:00.000Z',
		})

		expect(result.status).toBe('recorded')
		expect(
			Array.from(repository.nextActions.values()).find(
				(action) => action.type === 'advance-value-path',
			),
		).toMatchObject({ status: 'planned', reviewReasons: [] })
		expect(
			Array.from(repository.sideEffectIntents.values()).find(
				(intent) => intent.type === 'send-value-path-email',
			),
		).toMatchObject({
			provider: 'kit',
			status: 'pending',
			metadata: {
				mode: 'allowlisted-test',
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-2',
				kitSubscriberId: 'kit_123',
				kitSequenceId: '2757201',
			},
		})
	})

	it('uses the answer page next sequence as the next value path slug', async () => {
		const { repository, captured } = await makeProgressionFixture()
		const result = await recordValuePathAnswerProgression({
			repository,
			token: {
				contactId: captured.contact.id,
				kitSubscriberId: 'kit_123',
				valuePathResourceId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				sequenceId: 'ai-hero-skills-workflow',
				expiresAt: '2026-05-14T12:00:00.000Z',
			},
			answerPage: makeAnswerPage({
				optionValue: 'team',
				nextSequenceId: 'ai-hero-skills-team-workflow',
				nextEmailId: 'team-email-1',
				nextEmailResourceId: 'ai-hero-skills-team-workflow.team-email-1',
				kitSequenceId: '2757207',
			}),
			mode: 'allowlisted-test',
			sendGate: {
				allowlistedContactIds: [captured.contact.id],
				enabledValuePathSlugs: ['ai-hero-skills-team-workflow'],
				verifiedEmailResourceIds: ['ai-hero-skills-team-workflow.team-email-1'],
				verifiedKitSequenceIds: ['2757207'],
			},
			now: '2026-05-14T11:05:00.000Z',
		})

		expect(result.status).toBe('recorded')
		expect(
			Array.from(repository.sideEffectIntents.values()).find(
				(intent) => intent.type === 'send-value-path-email',
			),
		).toMatchObject({
			status: 'pending',
			metadata: {
				valuePathSlug: 'ai-hero-skills-team-workflow',
				emailResourceId: 'ai-hero-skills-team-workflow.team-email-1',
				kitSequenceId: '2757207',
				optionValue: 'team',
			},
		})
	})

	it('does not duplicate SideEffectIntent for duplicate answer clicks', async () => {
		const { repository, captured } = await makeProgressionFixture()
		const token = {
			contactId: captured.contact.id,
			valuePathResourceId: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-1',
			sequenceId: 'ai-hero-skills-workflow',
			expiresAt: '2026-05-14T12:00:00.000Z',
		}
		await recordValuePathAnswerProgression({
			repository,
			token,
			answerPage: makeAnswerPage(),
		})
		const duplicate = await recordValuePathAnswerProgression({
			repository,
			token,
			answerPage: makeAnswerPage(),
		})

		expect(duplicate.status).toBe('idempotent-noop')
		expect(
			Array.from(repository.sideEffectIntents.values()).filter(
				(intent) => intent.type === 'send-value-path-email',
			),
		).toHaveLength(1)
	})

	it('skips progression once a contact exceeds the plausible click volume', async () => {
		const { repository, captured } = await makeProgressionFixture()
		for (
			let index = 0;
			index < MAX_PLAUSIBLE_ANSWER_CLICKS_PER_CONTACT;
			index++
		) {
			repository.createContactEvent({
				contactId: captured.contact.id,
				providerIdentityId: captured.providerIdentity.id,
				provider: 'ai-hero',
				providerEventId: `scanner-${index}`,
				providerReference: `/ask/option-${index}`,
				eventType: 'value-path.answer-selected',
				occurredAt: '2026-05-14T11:04:00.000Z',
				semanticIdempotencyKey: `scanner-${index}`,
				privacyLevel: 'internal',
				identityEvidence: captured.providerIdentity.evidence,
				payloadSummary: {
					summary: `Selected answer option-${index} for email-1.quiz`,
					keywords: ['value-path', 'answer-selected'],
					restrictedPayloadStored: false,
				},
				schemaVersion: 1,
				createdAt: '2026-05-14T11:04:00.000Z',
			})
		}
		const result = await recordValuePathAnswerProgression({
			repository,
			token: {
				contactId: captured.contact.id,
				valuePathResourceId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				sequenceId: 'ai-hero-skills-workflow',
				expiresAt: '2026-05-14T12:00:00.000Z',
			},
			answerPage: makeAnswerPage(),
			now: '2026-05-14T11:05:00.000Z',
		})

		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'answer-click-volume-implausible',
		})
		expect(
			Array.from(repository.sideEffectIntents.values()).filter(
				(intent) => intent.type === 'send-value-path-email',
			),
		).toHaveLength(0)
	})

	it('skips progression when the answer page has no next email resource', async () => {
		const { repository, captured } = await makeProgressionFixture()
		const result = await recordValuePathAnswerProgression({
			repository,
			token: {
				contactId: captured.contact.id,
				valuePathResourceId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				sequenceId: 'ai-hero-skills-workflow',
				expiresAt: '2026-05-14T12:00:00.000Z',
			},
			answerPage: makeAnswerPage({ nextEmailResourceId: undefined }),
		})

		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'next-email-resource-missing',
		})
		expect(
			Array.from(repository.sideEffectIntents.values()).filter(
				(intent) => intent.type === 'send-value-path-email',
			),
		).toHaveLength(0)
	})
})

describe('subscriber marketing value path answer pages', () => {
	const secret = 'test-secret'
	const payload = {
		contactId: 'contact_123',
		kitSubscriberId: 'kit_123',
		valuePathResourceId: 'ai-hero-skills-workflow',
		emailResourceId: 'ai-hero-skills-workflow.email-1',
		sequenceId: 'ai-hero-skills-workflow',
		expiresAt: '2026-05-14T12:00:00.000Z',
	}

	it('signs and verifies value path tokens without answer state', () => {
		const token = signValuePathToken({ payload, secret })
		const verified = verifyValuePathToken({
			token,
			secret,
			now: new Date('2026-05-14T11:00:00.000Z'),
		})

		expect(verified.valid).toBe(true)
		if (verified.valid) {
			expect(verified.payload).toEqual(payload)
			expect(verified.payload).not.toHaveProperty('answerPageId')
			expect(verified.payload).not.toHaveProperty('optionValue')
			expect(verified.payload).not.toHaveProperty('nextEmailResourceId')
		}
	})

	it('rejects missing, expired, and tampered value path tokens', () => {
		const token = signValuePathToken({ payload, secret })
		const tampered = token.replace(/.$/, token.endsWith('a') ? 'b' : 'a')

		expect(verifyValuePathToken({ secret })).toMatchObject({
			valid: false,
			reason: 'missing',
		})
		expect(
			verifyValuePathToken({
				token,
				secret,
				now: new Date('2026-05-14T12:00:00.000Z'),
			}),
		).toMatchObject({ valid: false, reason: 'expired' })
		expect(
			verifyValuePathToken({
				token: tampered,
				secret,
				now: new Date('2026-05-14T11:00:00.000Z'),
			}),
		).toMatchObject({ valid: false, reason: 'tampered' })
	})

	it('parses answer page ContentResources by slug shape', () => {
		const page = parseValuePathAnswerPageResource({
			id: 'answer_123',
			type: 'value-path-page',
			fields: {
				kind: 'answer',
				slug: 'skills-workflow-email-1-correct',
				headline: 'That is the move.',
				body: 'Use the skill before making the agent guess.',
				takeaway: 'Clarify first.',
				nextNotice: 'Check your inbox in a few minutes for the next lesson.',
				sequenceId: 'ai-hero-skills-workflow',
				emailId: 'email-1',
				surveyId: 'email-1.quiz',
				optionValue: 'correct',
				nextEmailId: 'email-2',
				nextEmailResourceId: 'ai-hero-skills-workflow.email-2',
			},
		})

		expect(page).toMatchObject({
			id: 'answer_123',
			fields: {
				slug: 'skills-workflow-email-1-correct',
				headline: 'That is the move.',
				nextNotice: 'Check your inbox in a few minutes for the next lesson.',
			},
		})
		expect(parseValuePathAnswerPageResource({ type: 'page' })).toBeNull()
	})
})

describe('subscriber marketing value path foundation', () => {
	const individualSequence = `<EmailSequence id="ai-hero-skills-workflow" title="AI Hero Skills Workflow">
<EmailPlan id="email-0"><Subject>Welcome</Subject><Preview>Start here</Preview><Body>Pick a path.</Body><Survey id="email-0" type="segmentation"><Question>Choose</Question><Option value="personal">Personal</Option><Option value="team">Team</Option></Survey></EmailPlan>
<EmailPlan id="email-1"><Subject>Lesson 1</Subject><Preview>Next</Preview></EmailPlan>
</EmailSequence>`
	const teamSequence = `<EmailSequence id="ai-hero-skills-team-workflow" title="AI Hero Skills Workflow for Teams">
<EmailPlan id="team-email-0"><Subject>Team welcome</Subject><Survey id="team-email-0" type="segmentation"><Question>Stage</Question><Option value="starting">Starting</Option></Survey></EmailPlan>
<EmailPlan id="team-email-1"><Subject>Team lesson</Subject></EmailPlan>
</EmailSequence>`
	const individualAnswers = `<AnswerPageSet id="ai-hero-skills-workflow-answer-pages" sequenceId="ai-hero-skills-workflow">
<AnswerPage id="email-0.personal" slug="skills-workflow-email-0-personal" sequenceId="ai-hero-skills-workflow" emailId="email-0" surveyId="email-0" optionValue="personal" result="personal" nextEmailId="email-1"><Headline>Good</Headline></AnswerPage>
<AnswerPage id="email-0.team" slug="skills-workflow-email-0-team" sequenceId="ai-hero-skills-workflow" emailId="email-0" surveyId="email-0" optionValue="team" result="team" nextSequenceId="ai-hero-skills-team-workflow" nextEmailId="team-email-1"><Headline>Team</Headline></AnswerPage>
</AnswerPageSet>`
	const teamAnswers = `<AnswerPageSet id="ai-hero-skills-team-workflow-answer-pages" sequenceId="ai-hero-skills-team-workflow">
<AnswerPage id="team-email-0.starting" slug="skills-team-workflow-email-0-starting" sequenceId="ai-hero-skills-team-workflow" emailId="team-email-0" surveyId="team-email-0" optionValue="starting" result="starting" nextEmailId="team-email-1"><Headline>Good</Headline></AnswerPage>
</AnswerPageSet>`

	it('previews Skills Workflow ContentResource imports without writes', () => {
		const preview = previewValuePathContentImport({
			individualSequenceMdx: individualSequence,
			teamSequenceMdx: teamSequence,
			individualAnswerPagesMdx: individualAnswers,
			teamAnswerPagesMdx: teamAnswers,
		})

		expect(preview.mode).toBe('dry-run')
		expect(preview.counts).toEqual({ parents: 2, emails: 4, answers: 3 })
		expect(preview.parents.map((parent) => parent.slug)).toEqual([
			'ai-hero-skills-workflow',
			'ai-hero-skills-team-workflow',
		])
		expect(
			preview.pages.find(
				(page) => page.kind === 'answer' && page.optionValue === 'personal',
			),
		).toMatchObject({ nextEmailResourceId: 'ai-hero-skills-workflow.email-1' })
		expect(
			preview.pages.find(
				(page) => page.kind === 'answer' && page.optionValue === 'team',
			),
		).toMatchObject({
			nextSequenceId: 'ai-hero-skills-team-workflow',
			nextEmailResourceId: 'ai-hero-skills-team-workflow.team-email-1',
		})
		expect(preview.warnings).toContain(
			'kit-sequence-missing:ai-hero-skills-workflow.email-0',
		)
		expect(
			preview.pages.find(
				(page) => page.kind === 'email' && page.emailId === 'email-0',
			),
		).toMatchObject({
			body: 'Pick a path.',
			survey: {
				id: 'email-0',
				options: [
					{ value: 'personal', label: 'Personal', correct: false },
					{ value: 'team', label: 'Team', correct: false },
				],
			},
		})
	})

	it('builds an operator QA preview with redacted ask links and share metadata', () => {
		const individualSequenceWithKit = individualSequence
			.replace(
				'<EmailPlan id="email-0"',
				'<EmailPlan id="email-0" kitSequenceId="2757199"',
			)
			.replace(
				'<EmailPlan id="email-1"',
				'<EmailPlan id="email-1" kitSequenceId="2757200"',
			)
			.replace(
				'</EmailPlan>\n</EmailSequence>',
				'<CTA>Complete the course and get your certificate</CTA></EmailPlan>\n</EmailSequence>',
			)
		const teamSequenceWithKit = teamSequence
			.replace(
				'<EmailPlan id="team-email-0"',
				'<EmailPlan id="team-email-0" kitSequenceId="2757206"',
			)
			.replace(
				'<EmailPlan id="team-email-1"',
				'<EmailPlan id="team-email-1" kitSequenceId="2757207"',
			)
			.replace(
				'</EmailSequence>',
				'<EmailPlan id="team-email-6" kitSequenceId="2757212"><Subject>Share</Subject><Body>{{ subscriber.aih_team_share_url }}</Body></EmailPlan></EmailSequence>',
			)
		const preview = previewValuePathContentImport({
			individualSequenceMdx: individualSequenceWithKit,
			teamSequenceMdx: teamSequenceWithKit,
			individualAnswerPagesMdx: individualAnswers,
			teamAnswerPagesMdx: teamAnswers,
		})
		const qa = previewSkillsWorkflowValuePathQa({
			preview,
			individualSequenceMdx: individualSequenceWithKit,
			teamSequenceMdx: teamSequenceWithKit,
			teamShareLinkMap: {
				links: {
					teamEmail6ShareCta: {
						shortlinkId: 'hknb4',
						slug: 'skills-workflow-team-share',
						shortUrl: 'https://www.aihero.dev/s/skills-workflow-team-share',
						destinationUrl: 'https://www.aihero.dev/skills?preview=form',
						signupSurface: 'skills_newsletter',
						metadata: {
							sourceSurface: 'sequence',
							sourceId: 'team-email-6',
							contentSlug: 'ai-hero-skills-workflow',
							valuePath: 'ai-hero-skills-team-workflow',
							linkRole: 'share_value_path',
							signupSurface: 'skills_newsletter',
						},
					},
				},
			},
		})

		expect(qa.counts).toMatchObject({
			parents: 2,
			emails: 5,
			answers: 3,
			share: 1,
			certificate: 1,
		})
		expect(qa.surveyOptions).toHaveLength(3)
		expect(qa.surveyOptions[0]?.answerPageSlug).toBe(
			'skills-workflow-email-0-personal',
		)
		expect(qa.surveyOptions[0]?.askLinkPreview).toContain(
			'pt=<redacted-path-token>',
		)
		expect(JSON.stringify(qa)).not.toContain('aih_value_path_token')
		expect(qa.answerRoutes[0]).toMatchObject({
			nextEmailId: 'email-1',
			nextEmailResourceId: 'ai-hero-skills-workflow.email-1',
			kitSequenceId: '2757200',
		})
		expect(qa.teamShareCta).toMatchObject({
			status: 'present',
			slug: 'skills-workflow-team-share',
			signupSurface: 'skills_newsletter',
		})
		expect(qa.blockers).toEqual([])
	})

	it('builds a dry-run ContentResource import plan without database writes', async () => {
		const preview = previewValuePathContentImport({
			individualSequenceMdx: individualSequence,
			teamSequenceMdx: teamSequence,
			individualAnswerPagesMdx: individualAnswers,
			teamAnswerPagesMdx: teamAnswers,
		})
		const plan = buildValuePathContentResourcePlan(preview)
		const result = await importValuePathContentResources({ preview })

		expect(plan.resources).toHaveLength(9)
		expect(plan.relations).toHaveLength(7)
		expect(
			plan.resources.find(
				(resource) => resource.id === 'ai-hero-skills-workflow.email-0',
			),
		).toMatchObject({
			type: 'value-path-page',
			fields: { kind: 'email', slug: 'ai-hero-skills-workflow-email-0' },
		})
		expect(result.mode).toBe('dry-run')
		expect(result.operations[0]).toMatchObject({ action: 'would-upsert' })
	})

	it('generates signed ask links for answer pages', () => {
		const page = parseValuePathAnswerPageResource({
			id: 'answer_123',
			type: 'value-path-page',
			fields: {
				kind: 'answer',
				slug: 'ai-hero-skills-workflow-email-1-correct',
				optionValue: 'correct',
			},
		})!
		const href = buildValuePathAskUrl({
			baseUrl: 'https://www.aihero.dev/',
			secret: 'test-secret',
			slug: page.fields.slug,
			tokenPayload: {
				contactId: 'contact_123',
				valuePathResourceId: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-1',
				sequenceId: 'ai-hero-skills-workflow',
				expiresAt: '2026-05-14T12:00:00.000Z',
			},
		})

		expect(href).toContain(
			'https://www.aihero.dev/ask/ai-hero-skills-workflow-email-1-correct?pt=',
		)
	})

	it('executes pending value path Kit sequence enrollment when Send Gate D passes', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-14T11:00:00.000Z',
		})
		const calls: Array<{
			listId: string
			email: string
			fields: Record<string, string>
		}> = []
		const intent = repository.createSideEffectIntent({
			id: 'intent_send_1',
			nextActionId: 'next_action_1',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'pending',
			idempotencyKey:
				'contact:fixture_contact_1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-2',
			gates: [],
			reviewReasons: [],
			metadata: {
				mode: 'allowlisted-test',
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-2',
				kitSequenceId: '2757201',
				kitSubscriberId: 'kit_123',
				providerResult: null,
			},
			createdAt: '2026-05-14T11:05:00.000Z',
		})

		const result = await executeValuePathEmailIntent({
			repository,
			intent,
			emailListProvider: {
				async subscribeToList(args) {
					calls.push({
						listId: String(args.listId),
						email: args.user.email,
						fields: args.fields,
					})
					return { id: 'kit-subscription-1', email_address: args.user.email }
				},
			},
			config: {
				mode: 'allowlisted-test',
				allowlistedContactIds: [captured.contact.id],
				baseUrl: 'https://www.aihero.dev',
				pathTokenSecret: 'test-secret',
				answerPages: [
					parseValuePathAnswerPageResource({
						id: 'answer-email-2-correct',
						type: 'value-path-page',
						fields: {
							kind: 'answer',
							sequenceId: 'ai-hero-skills-workflow',
							emailId: 'email-2',
							optionValue: 'correct',
							slug: 'ai-hero-skills-workflow-email-2-correct',
						},
					})!,
				],
			},
			now: '2026-05-14T11:06:00.000Z',
		})

		expect(result).toMatchObject({
			status: 'completed',
			intentId: 'intent_send_1',
			kitSequenceId: '2757201',
		})
		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatchObject({
			listId: '2757201',
			email: captured.contact.email,
		})
		expect(calls[0]?.fields.aih_value_path_answer_1_url).toContain(
			'/ask/ai-hero-skills-workflow-email-2-correct?pt=',
		)
		expect(calls[0]?.fields.aih_value_path_answer_correct_url).toContain(
			'/ask/ai-hero-skills-workflow-email-2-correct?pt=',
		)
		expect(repository.sideEffectIntents.get('intent_send_1')).toMatchObject({
			status: 'completed',
			reviewReasons: [],
			metadata: {
				completedAt: '2026-05-14T11:06:00.000Z',
				providerResult: { ok: true, id: 'kit-subscription-1' },
			},
		})
	})

	it('marks transient Kit enrollment failures retryable and picks them up when due', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-14T11:00:00.000Z',
		})
		repository.createSideEffectIntent({
			id: 'intent_retryable_send',
			nextActionId: 'next_action_1',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'pending',
			idempotencyKey:
				'contact:fixture_contact_1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-6',
			gates: [],
			reviewReasons: [],
			metadata: {
				mode: 'allowlisted-test',
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-6',
				kitSequenceId: '2757205',
				kitSubscriberId: 'kit_123',
				providerResult: null,
			},
			createdAt: '2026-05-14T11:05:00.000Z',
		})

		const first = await executePendingValuePathEmailIntents({
			repository,
			emailListProvider: {
				async subscribeToList() {
					throw new SyntaxError(
						'Unexpected token R, "Retry later" is not valid JSON',
					)
				},
			},
			config: {
				mode: 'allowlisted-test',
				allowlistedContactIds: [captured.contact.id],
				verifiedEmailResourceIds: ['ai-hero-skills-workflow.email-6'],
				verifiedKitSequenceIds: ['2757205'],
				enabledValuePathSlugs: ['ai-hero-skills-workflow'],
			},
			now: '2026-05-14T11:06:00.000Z',
		})

		expect(first).toMatchObject([
			{
				status: 'retryable-failed',
				intentId: 'intent_retryable_send',
				reviewReasons: ['kit-sequence-enrollment-retryable'],
			},
		])
		expect(
			repository.sideEffectIntents.get('intent_retryable_send'),
		).toMatchObject({
			status: 'failed',
			reviewReasons: ['kit-sequence-enrollment-retryable'],
			metadata: {
				providerResult: {
					ok: false,
					error: 'Unexpected token R, "Retry later" is not valid JSON',
				},
				retryable: true,
				retryReason: 'kit-retry-later',
				retryAttemptCount: 1,
				nextRetryAt: '2026-05-14T11:21:00.000Z',
			},
		})

		let calls = 0
		const second = await executePendingValuePathEmailIntents({
			repository,
			emailListProvider: {
				async subscribeToList(args) {
					calls++
					return {
						id: 'kit-subscription-retry',
						email_address: args.user.email,
					}
				},
			},
			config: {
				mode: 'allowlisted-test',
				allowlistedContactIds: [captured.contact.id],
				verifiedEmailResourceIds: ['ai-hero-skills-workflow.email-6'],
				verifiedKitSequenceIds: ['2757205'],
				enabledValuePathSlugs: ['ai-hero-skills-workflow'],
			},
			now: '2026-05-14T11:22:00.000Z',
		})

		expect(calls).toBe(1)
		expect(second).toMatchObject([
			{
				status: 'completed',
				intentId: 'intent_retryable_send',
				kitSequenceId: '2757205',
			},
		])
	})

	it('uses the authorization retry policy for transient Kit failures', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-14T11:00:00.000Z',
		})
		repository.createSideEffectIntent({
			id: 'intent_retry_policy_send',
			nextActionId: 'next_action_1',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'pending',
			idempotencyKey:
				'contact:fixture_contact_1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-6',
			gates: [],
			reviewReasons: [],
			metadata: {
				mode: 'allowlisted-test',
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-6',
				kitSequenceId: '2757205',
				kitSubscriberId: 'kit_123',
				providerResult: null,
			},
			createdAt: '2026-05-14T11:05:00.000Z',
		})

		await executePendingValuePathEmailIntents({
			repository,
			emailListProvider: {
				async subscribeToList() {
					throw new Error('Retry later')
				},
			},
			config: {
				mode: 'allowlisted-test',
				allowlistedContactIds: [captured.contact.id],
				verifiedEmailResourceIds: ['ai-hero-skills-workflow.email-6'],
				verifiedKitSequenceIds: ['2757205'],
				enabledValuePathSlugs: ['ai-hero-skills-workflow'],
				allowedActions: [
					'send-path-emails',
					'retry-transient-provider-failures',
				],
				retryPolicy: {
					providerRetryDelayMinutes: 2,
					maxProviderRetryAttempts: 3,
				},
			},
			now: '2026-05-14T11:06:00.000Z',
		})

		expect(
			repository.sideEffectIntents.get('intent_retry_policy_send'),
		).toMatchObject({
			status: 'failed',
			metadata: {
				retryable: true,
				retryAttemptCount: 1,
				maxRetryAttempts: 3,
				nextRetryAt: '2026-05-14T11:08:00.000Z',
			},
		})
	})

	it('preflights missing path token secret before mutating due retryable rows', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-14T11:00:00.000Z',
		})
		repository.createSideEffectIntent({
			id: 'intent_retryable_missing_secret',
			nextActionId: 'next_action_1',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'failed',
			idempotencyKey:
				'contact:fixture_contact_1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-2',
			gates: [],
			reviewReasons: ['kit-sequence-enrollment-retryable'],
			metadata: {
				mode: 'allowlisted-test',
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-2',
				kitSequenceId: '2757201',
				kitSubscriberId: 'kit_123',
				providerResult: { ok: false, error: 'Retry later' },
				retryable: true,
				retryReason: 'kit-retry-later',
				retryAttemptCount: 1,
				nextRetryAt: '2026-05-14T11:21:00.000Z',
			},
			createdAt: '2026-05-14T11:05:00.000Z',
		})

		const result = await executePendingValuePathEmailIntents({
			repository,
			emailListProvider: {
				async subscribeToList() {
					throw new Error('should not subscribe without token secret')
				},
			},
			config: {
				mode: 'allowlisted-test',
				allowlistedContactIds: [captured.contact.id],
				verifiedEmailResourceIds: ['ai-hero-skills-workflow.email-2'],
				verifiedKitSequenceIds: ['2757201'],
				enabledValuePathSlugs: ['ai-hero-skills-workflow'],
				baseUrl: 'https://www.aihero.dev',
				answerPages: [
					parseValuePathAnswerPageResource({
						id: 'answer-email-2-correct',
						type: 'value-path-page',
						fields: {
							kind: 'answer',
							sequenceId: 'ai-hero-skills-workflow',
							emailId: 'email-2',
							optionValue: 'correct',
							slug: 'ai-hero-skills-workflow-email-2-correct',
						},
					})!,
				],
			},
			now: '2026-05-14T11:22:00.000Z',
		})

		expect(result).toEqual([
			{
				status: 'blocked',
				intentId: 'executor-preflight',
				reviewReasons: ['path-token-secret-missing'],
			},
		])
		expect(
			repository.sideEffectIntents.get('intent_retryable_missing_secret'),
		).toMatchObject({
			status: 'failed',
			reviewReasons: ['kit-sequence-enrollment-retryable'],
			metadata: {
				retryable: true,
				nextRetryAt: '2026-05-14T11:21:00.000Z',
			},
		})
	})

	it('classifies Kit transient enrollment errors as retryable', () => {
		expect(classifyKitEnrollmentError(new Error('Retry later'))).toMatchObject({
			retryable: true,
			reason: 'kit-retry-later',
		})
		expect(
			classifyKitEnrollmentError({
				message: 'ConvertKit API returned non-JSON response: Retry later',
				status: 200,
				bodySnippet: 'Retry later\n',
			}),
		).toMatchObject({
			retryable: true,
			reason: 'kit-retry-later',
		})
		expect(classifyKitEnrollmentError(new Error('HTTP 429'))).toMatchObject({
			retryable: true,
			reason: 'kit-rate-limited',
		})
		expect(classifyKitEnrollmentError(new Error('HTTP 503'))).toMatchObject({
			retryable: true,
			reason: 'kit-5xx',
		})
		expect(classifyKitEnrollmentError(new Error('TimeoutError'))).toMatchObject(
			{
				retryable: true,
				reason: 'kit-timeout',
			},
		)
		expect(
			classifyKitEnrollmentError(
				new SyntaxError('Unexpected token R, "Retry later" is not valid JSON'),
			),
		).toMatchObject({ retryable: true, reason: 'kit-retry-later' })
	})

	it('blocks value path sends when tokenized answer links cannot be built', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const captured = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-14T11:00:00.000Z',
		})
		const intent = repository.createSideEffectIntent({
			id: 'intent_send_missing_links',
			nextActionId: 'next_action_1',
			contactId: captured.contact.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'pending',
			idempotencyKey:
				'contact:fixture_contact_1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-2',
			gates: [],
			reviewReasons: [],
			metadata: {
				mode: 'allowlisted-test',
				valuePathSlug: 'ai-hero-skills-workflow',
				emailResourceId: 'ai-hero-skills-workflow.email-2',
				kitSequenceId: '2757201',
				kitSubscriberId: 'kit_123',
				providerResult: null,
			},
			createdAt: '2026-05-14T11:05:00.000Z',
		})

		const result = await executeValuePathEmailIntent({
			repository,
			intent,
			emailListProvider: {
				async subscribeToList() {
					throw new Error('should not subscribe without tokenized links')
				},
			},
			config: {
				mode: 'allowlisted-test',
				allowlistedContactIds: [captured.contact.id],
				baseUrl: 'https://www.aihero.dev',
				pathTokenSecret: 'test-secret',
				answerPages: [],
			},
			now: '2026-05-14T11:06:00.000Z',
		})

		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['answer-pages-missing'],
		})
		expect(
			repository.sideEffectIntents.get('intent_send_missing_links'),
		).toMatchObject({
			status: 'blocked',
			reviewReasons: ['answer-pages-missing'],
		})
	})

	it('keeps value path sends blocked in default dry-run mode', () => {
		const decision = evaluateValuePathEmailSendGate({
			contactId: 'contact_123',
			kitSubscriberId: 'sub_123',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-1',
			kitSequenceId: 'kit-sequence-1',
		})

		expect(decision.passed).toBe(false)
		expect(decision.mode).toBe('dry-run')
		expect(decision.reviewReasons).toContain('mode-dry-run')
		expect(decision.gates[0]?.slug).toBe('gate-d-value-path-email')
	})

	it('allows only allowlisted contacts in allowlisted-test mode', () => {
		const blocked = evaluateValuePathEmailSendGate({
			mode: 'allowlisted-test',
			contactId: 'contact_123',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-1',
			kitSequenceId: 'kit-sequence-1',
		})
		const allowed = evaluateValuePathEmailSendGate({
			mode: 'allowlisted-test',
			contactId: 'contact_123',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-1',
			kitSequenceId: 'kit-sequence-1',
			allowlistedContactIds: ['contact_123'],
		})

		expect(blocked.reviewReasons).toContain('contact-not-allowlisted')
		expect(allowed.passed).toBe(true)

		const wrongSequence = evaluateValuePathEmailSendGate({
			mode: 'allowlisted-test',
			contactId: 'contact_123',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
			kitSequenceId: '2757200',
			allowlistedContactIds: ['contact_123'],
			enabledValuePathSlugs: ['ai-hero-skills-workflow'],
			verifiedEmailResourceIds: ['ai-hero-skills-workflow.email-0'],
			verifiedKitSequenceIds: ['2757199'],
		})
		expect(wrongSequence.reviewReasons).toContain(
			'kit-sequence-not-allowlisted',
		)
	})

	it('treats allowlisted pilot review noise as advisory while keeping stop-the-line signals blocked', () => {
		const buying = evaluateValuePathEmailSendGate({
			mode: 'allowlisted-test',
			contactId: 'contact_123',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-1',
			kitSequenceId: 'kit-sequence-1',
			allowlistedContactIds: ['contact_123'],
			humanReview: true,
			reviewSignals: ['buying', 'low-confidence', 'ambiguous'],
		})

		expect(buying.passed).toBe(true)
		expect(buying.reviewReasons).toEqual([])
		expect(buying.advisoryReasons).toEqual([
			'human-review',
			'review-signal-buying',
			'review-signal-low-confidence',
			'review-signal-ambiguous',
		])

		const support = evaluateValuePathEmailSendGate({
			mode: 'allowlisted-test',
			contactId: 'contact_123',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-1',
			kitSequenceId: 'kit-sequence-1',
			allowlistedContactIds: ['contact_123'],
			humanReview: true,
			reviewSignals: ['support'],
		})

		const accepted = applyAcceptedValuePathSendGateReviewReasons(support, [
			'human-review',
		])

		expect(accepted.advisoryReasons).not.toContain('human-review')
		expect(accepted.reviewReasons).toContain('support-intent')
		expect(accepted.passed).toBe(false)
	})

	it('blocks scoped live sends without verified scope and suppression clearance', () => {
		const decision = evaluateValuePathEmailSendGate({
			mode: 'scoped-live',
			contactId: 'contact_123',
			valuePathSlug: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-1',
			kitSequenceId: 'kit-sequence-1',
			unsubscribed: true,
			enabledValuePathSlugs: ['ai-hero-skills-workflow'],
			verifiedEmailResourceIds: ['ai-hero-skills-workflow.email-1'],
			verifiedKitSequenceIds: ['kit-sequence-1'],
		})

		expect(decision.passed).toBe(false)
		expect(decision.reviewReasons).toContain('unsubscribed')
	})
})

describe('subscriber marketing Gate A spine', () => {
	it('normalizes fixture events with minimized payload summaries and semantic idempotency', () => {
		const event = normalizeContactEvent({
			...codingWorkflowFixture,
			email: 'UPPER@Example.COM',
		})

		expect(event.identityEvidence.email).toBe('upper@example.com')
		expect(event.semanticIdempotencyKey).toContain(
			'fixture:quick-question.reply',
		)
		expect(event.payloadSummary.restrictedPayloadStored).toBe(false)
		expect(event.payloadSummary.summary.length).toBeLessThanOrEqual(180)
		expect(event.payloadSummary.summary).not.toContain(
			codingWorkflowFixture.message,
		)
	})

	it('classifies into real quick-question buckets without LLMs', () => {
		const result = classifyContactEvent(
			normalizeContactEvent(codingWorkflowFixture),
		)

		expect(result.whySignals).toContain('ai-coding-workflow-real-engineering')
		expect(result.whoSignals).toContain('professional-software-engineer')
		expect(result.primaryBucket).toBe('ai-coding-workflow-real-engineering')
		expect(result.confidence).toBeGreaterThan(0.5)
		expect(result.humanReview).toBe(false)
	})

	it('does not classify internal buy-in as buying intent', () => {
		const result = classifyContactEvent(
			normalizeContactEvent({
				...codingWorkflowFixture,
				providerEventId: 'fixture-buy-in',
				message:
					'I am trying to build internal buy-in within my organization for better AI coding workflows.',
			}),
		)

		expect(result.reviewSignals).not.toContain('buying')
	})

	it.each([
		'I am buying seats for my team.',
		'What is the purchase flow?',
		'Do you have a refund policy?',
		'Is there a discount coupon?',
	])('keeps real buying signal detection for: %s', (message) => {
		const result = classifyContactEvent(
			normalizeContactEvent({
				...codingWorkflowFixture,
				providerEventId: `fixture-buying-${message}`,
				message,
			}),
		)

		expect(result.reviewSignals).toContain('buying')
	})

	it('creates provisional contact, provider identity, event, state, transition, action, and dry-run intent', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
			now: '2026-05-04T13:00:00.000Z',
		})

		expect(result.idempotentNoop).toBe(false)
		expect(result.contact.lifecycle).toBe('new')
		expect(result.contact.isProvisional).toBe(true)
		expect(result.providerIdentity.provider).toBe('fixture')
		expect(result.contactState.primaryBucket).toBe(
			'ai-coding-workflow-real-engineering',
		)
		expect(result.stateTransition?.eventId).toBe(result.contactEvent.id)
		expect(result.nextAction.status).toBe('planned')
		expect(result.sideEffectIntents[0]?.status).toBe('dry-run')
		expect(result.sideEffectIntents[0]?.provider).toBe('dry-run')
		expect(result.privacy.rawPayloadIncluded).toBe(false)
	})

	it('does not merge contacts only because they share email', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const first = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		const second = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: {
				...codingWorkflowFixture,
				providerEventId: 'fixture-event-merge-risk',
				externalId: 'different-provider-identity',
			},
		})

		expect(second.contact.id).not.toBe(first.contact.id)
		expect(repository.contacts.size).toBe(2)
	})

	it('dedupes duplicate semantic idempotency keys as a no-op', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const first = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		const second = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})

		expect(second.idempotentNoop).toBe(true)
		expect(second.contactEvent.id).toBe(first.contactEvent.id)
		expect(repository.contactEvents.size).toBe(1)
	})

	it('treats Human Review Flag as a hard stop', async () => {
		const result = await dryRunSubscriberMarketingFixture({
			fixture: supportFixture,
		})

		expect(result.classification.reviewSignals).toContain('support')
		expect(result.contactState.humanReview).toBe(true)
		expect(result.nextAction.status).toBe('blocked')
		expect(result.nextAction.type).toBe('human-review')
		expect(result.sideEffectIntents[0]?.status).toBe('blocked')
		expect(
			result.nextAction.gates.find((gate) => gate.slug === 'human-review')
				?.passed,
		).toBe(false)
	})

	it('keeps restricted payloads summarized and blocks for review', async () => {
		const result = await dryRunSubscriberMarketingFixture({
			fixture: restrictedFixture,
		})

		expect(result.contactEvent.privacyLevel).toBe('restricted')
		expect(result.contactEvent.payloadSummary.restrictedPayloadStored).toBe(
			false,
		)
		expect(result.contactEvent.payloadSummary.summary).not.toContain(
			'founder building',
		)
		expect(result.classification.reviewSignals).toContain('restricted-payload')
		expect(result.privacy.payloadSummaryOnly).toBe(true)
	})

	it('looks up operator-safe contacts by normalized email without merging candidates', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		await dryRunSubscriberMarketingFixture({
			repository,
			fixture: {
				...codingWorkflowFixture,
				providerEventId: 'fixture-event-email-lookup-risk',
				externalId: 'email-lookup-second-provider-id',
			},
		})

		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'email', email: '  DEV@example.COM ' },
		})

		expect(lookup.contacts).toHaveLength(2)
		expect(lookup.ambiguous).toBe(true)
		expect(lookup.privacy.rawPayloadIncluded).toBe(false)
		expect(
			lookup.contacts[0]?.recentEvents[0]?.payloadSummary.summary,
		).not.toBe(codingWorkflowFixture.message)
	})

	it('looks up a contact by exact Contact ID', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})

		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'contact-id', contactId: result.contact.id },
		})

		expect(lookup.contacts).toHaveLength(1)
		expect(lookup.contacts[0]?.contact.id).toBe(result.contact.id)
		expect(lookup.contacts[0]?.currentState?.id).toBe(result.contactState.id)
		expect(lookup.contacts[0]?.nextActions[0]?.id).toBe(result.nextAction.id)
	})

	it('looks up a contact by exact provider identity', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})

		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: {
				type: 'provider-identity',
				provider: result.providerIdentity.provider,
				externalId: result.providerIdentity.externalId,
			},
		})

		expect(lookup.contacts).toHaveLength(1)
		expect(lookup.contacts[0]?.contact.id).toBe(result.contact.id)
		expect(lookup.contacts[0]?.providerIdentities[0]?.id).toBe(
			result.providerIdentity.id,
		)
	})

	it('looks up link-only contacts by user ID', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: codingWorkflowFixture,
		})
		repository.createContactLink({
			contactId: result.contact.id,
			userId: 'user_123',
			reason: 'operator-test-link',
			evidence: {
				...result.providerIdentity.evidence,
				rawMessage: 'must not be returned',
			},
			createdAt: '2026-05-04T13:00:00.000Z',
		})

		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'user-id', userId: 'user_123' },
		})

		expect(lookup.contacts).toHaveLength(1)
		expect(lookup.contacts[0]?.contactLinks[0]?.reason).toBe(
			'operator-test-link',
		)
		expect(lookup.contacts[0]?.contactLinks[0]?.evidence).not.toHaveProperty(
			'rawMessage',
		)
	})

	it('keeps restricted payloads summarized in operator lookup', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: restrictedFixture,
		})

		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'contact-id', contactId: result.contact.id },
		})

		expect(lookup.contacts[0]?.privacy.restrictedEventCount).toBe(1)
		expect(
			lookup.contacts[0]?.recentEvents[0]?.payloadSummary.summary,
		).not.toBe(restrictedFixture.message)
		expect(lookup.contacts[0]?.recentEvents[0]?.payloadSummary.summary).toBe(
			'Restricted provider payload present; raw text withheld from subscriber marketing output.',
		)
	})

	it('captures original Front quick-question replies as Gate B internal events', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_gate_b_001',
				messageId: 'msg_gate_b_001',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'FrontUser@Example.com',
				senderName: 'Front User',
				text: 'I am a professional engineer using AI coding agents in real production work.',
			},
			now: '2026-05-04T14:01:00.000Z',
		})

		expect(result.contactEvent.provider).toBe('front')
		expect(result.contactEvent.providerEventId).toBe(
			'cnv_gate_b_001:msg_gate_b_001',
		)
		expect(result.contact.email).toBe('frontuser@example.com')
		expect(result.nextAction.gates[0]?.slug).toBe('gate-b-internal-capture')
		expect(
			result.nextAction.gates.find(
				(gate) => gate.slug === 'customer-visible-side-effects',
			)?.passed,
		).toBe(false)
		expect(result.sideEffectIntents[0]?.idempotencyKey).toContain('gate-b:')
		expect(result.contactEvent.payloadSummary.summary).not.toContain(
			'professional engineer using AI coding agents',
		)
	})

	it('captures same-thread Front follow-ups as additional events', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const first = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_followup',
				messageId: 'msg_original',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'followup@example.com',
				text: 'I want better AI coding workflows for production engineering.',
			},
		})
		const second = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_followup',
				messageId: 'msg_followup',
				messageCreatedAt: '2026-05-04T14:05:00.000Z',
				senderEmail: 'followup@example.com',
				text: 'The annoying part is code review and keeping agents from drifting.',
				isFollowUp: true,
			},
		})

		expect(second.idempotentNoop).toBe(false)
		expect(second.contact.id).toBe(first.contact.id)
		expect(repository.contactEvents.size).toBe(2)
		expect(second.contactEvent.eventType).toBe('quick-question.follow-up-reply')
	})

	it('dedupes exact Front message capture without deduping the whole conversation', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const input = {
			conversationId: 'cnv_duplicate',
			messageId: 'msg_duplicate',
			messageCreatedAt: '2026-05-04T14:00:00.000Z',
			senderEmail: 'duplicate@example.com',
			text: 'I want agentic workflows for real software engineering.',
		}
		const first = await captureFrontQuickQuestion({ repository, input })
		const second = await captureFrontQuickQuestion({ repository, input })

		expect(first.idempotentNoop).toBe(false)
		expect(second.idempotentNoop).toBe(true)
		expect(repository.contactEvents.size).toBe(1)
	})

	it('captures same text with distinct Front message IDs as separate events', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const input = {
			conversationId: 'cnv_same_text',
			messageCreatedAt: '2026-05-04T14:00:00.000Z',
			senderEmail: 'same-text@example.com',
			text: 'I want agentic workflows for real software engineering.',
		}

		await captureFrontQuickQuestion({
			repository,
			input: { ...input, messageId: 'msg_same_text_1' },
		})
		await captureFrontQuickQuestion({
			repository,
			input: { ...input, messageId: 'msg_same_text_2' },
		})

		expect(repository.contactEvents.size).toBe(2)
	})

	it('captures support and team signals as human-review hard stops', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_team_support',
				messageId: 'msg_team_support',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'leader@example.com',
				text: 'I need help with team procurement for our engineering org and an invoice quote.',
			},
		})

		expect(result.contactState.humanReview).toBe(true)
		expect(result.classification.reviewSignals).toContain('support')
		expect(result.classification.reviewSignals).toContain('team-sales')
		expect(result.nextAction.status).toBe('blocked')
		expect(result.sideEffectIntents[0]?.status).toBe('blocked')
	})

	it('keeps restricted Front quick-question payloads summarized', async () => {
		const result = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_restricted_front',
				messageId: 'msg_restricted_front',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'private-front@example.com',
				text: 'This contains sensitive details about my company and project.',
				privacyLevel: 'restricted',
			},
		})

		expect(result.contactEvent.payloadSummary.summary).toBe(
			'Restricted provider payload present; raw text withheld from subscriber marketing output.',
		)
		expect(result.contactEvent.payloadSummary.restrictedPayloadStored).toBe(
			false,
		)
		expect(JSON.stringify(result)).not.toContain(
			'This contains sensitive details about my company and project.',
		)
		expect(result.classification.reviewSignals).toContain('restricted-payload')
	})

	it('blocks low-confidence Front quick-question captures for review', async () => {
		const result = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_low_confidence',
				messageId: 'msg_low_confidence',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'low-confidence@example.com',
				text: 'Thanks!',
			},
		})

		expect(result.classification.reviewSignals).toContain('low-confidence')
		expect(result.contactState.humanReview).toBe(true)
		expect(result.nextAction.status).toBe('blocked')
		expect(result.sideEffectIntents[0]?.status).toBe('blocked')
	})

	it('parses quick-question CSV identity rows without retaining payload text', () => {
		const parsed = parseQuickQuestionCsvForIdentity(
			[
				'Answer,Question,User,Created At,Conversation ID,Front URL',
				'"I want better workflows","A quick question",Buyer@Example.com,05/01/2026 10:00 AM,cnv_1,https://front.test/1',
				'"No email row","A quick question",not-an-email,05/01/2026 10:00 AM,cnv_2,https://front.test/2',
			].join('\n'),
		)

		expect(parsed.rows).toBe(2)
		expect(parsed.identities).toEqual([
			{ email: 'buyer@example.com', rowId: 'cnv_1' },
		])

		const frontExportParsed = parseQuickQuestionCsvForIdentity(
			[
				'Conversation ID,Message ID,Sender Email,Answer',
				'cnv_3,msg_3,FrontBuyer@Example.com,"I want better workflows"',
			].join('\n'),
		)
		expect(frontExportParsed.identities).toEqual([
			{ email: 'frontbuyer@example.com', rowId: 'cnv_3' },
		])
	})

	it('parses legacy quick-question analysis JSON identity rows', () => {
		const parsed = parseQuickQuestionAnalysisJsonForIdentity(
			JSON.stringify({
				conversations: [
					{ id: 'cnv_1', recipient: 'LegacyBuyer@Example.com' },
					{ id: 'cnv_2', recipient: 'not-an-email' },
				],
			}),
		)

		expect(parsed.rows).toBe(2)
		expect(parsed.identities).toEqual([
			{ email: 'legacybuyer@example.com', rowId: 'cnv_1' },
		])
	})

	it('previews purchase correlation from QQ emails without raw email output or writes', async () => {
		const repository: PurchasePreviewRepository = {
			async findProductsByIds(productIds) {
				return productIds.map((id) => ({ id, name: 'AI SDK v6 Crash Course' }))
			},
			async findPurchasesByProductIds(_productIds) {
				return [
					{
						purchaseId: 'purchase_1',
						productId: 'product-9wdta',
						productName: 'AI SDK v6 Crash Course',
						userId: 'user_1',
						email: 'buyer@example.com',
						createdAt: '2026-05-04T12:00:00.000Z',
						status: 'Valid',
						totalAmount: 149,
						country: 'US',
					},
					{
						purchaseId: 'purchase_2',
						productId: 'product-9wdta',
						productName: 'AI SDK v6 Crash Course',
						userId: 'user_2',
						email: 'someone-else@example.com',
						createdAt: '2026-05-04T13:00:00.000Z',
						status: 'Restricted',
						totalAmount: 52,
						country: 'CO',
					},
				]
			},
		}
		const result = await previewPurchaseCorrelation({
			repository,
			quickQuestionCsv: [
				'Answer,Question,User,Created At,Conversation ID,Front URL',
				'"I want better workflows","A quick question",buyer@example.com,05/01/2026 10:00 AM,cnv_1,https://front.test/1',
			].join('\n'),
			quickQuestionAnalysisJson: JSON.stringify({
				conversations: [{ id: 'cnv_2', recipient: 'buyer@example.com' }],
			}),
			productIds: ['product-9wdta'],
		})

		expect(result.mode).toBe('read-only-preview')
		expect(result.privacy.rawEmailsIncluded).toBe(false)
		expect(result.quickQuestion.rows).toBe(2)
		expect(result.quickQuestion.uniqueEmails).toBe(1)
		expect(result.products[0]?.totalPurchases).toBe(2)
		expect(result.products[0]?.matchedPurchases).toBe(1)
		expect(result.products[0]?.matchedExamples[0]?.qqResponses).toBe(2)
		expect(result.products[0]?.matchedExamples[0]?.domain).toBe('example.com')
		expect(JSON.stringify(result)).not.toContain('buyer@example.com')
	})

	it('captures a Front quick-question CSV backfill idempotently', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const csv = [
			'Conversation ID,Message ID,Message Created At UTC,Sender Name,Sender Email,Front Contact ID,Answer',
			'cnv_csv,msg_csv_1,2026-05-04T14:00:00Z,CSV User,csv@example.com,crd_csv,"I am a software engineer who wants AI coding workflows."',
			'cnv_csv,msg_csv_2,2026-05-04T14:05:00Z,CSV User,csv@example.com,crd_csv,"I also care about keeping agents from drifting."',
		].join('\n')

		const dryRun = await captureFrontQuickQuestionCsv({
			repository,
			csv,
			dryRun: true,
		})
		const first = await captureFrontQuickQuestionCsv({ repository, csv })
		const second = await captureFrontQuickQuestionCsv({ repository, csv })

		expect(dryRun.input.rows).toBe(2)
		expect(dryRun.result.captured).toBe(0)
		expect(first.result.captured).toBe(2)
		expect(first.result.failed).toBe(0)
		expect(second.result.captured).toBe(0)
		expect(second.result.idempotentNoops).toBe(2)
		expect(repository.contactEvents.size).toBe(2)
		expect(
			Array.from(repository.contactEvents.values()).map(
				(event) => event.eventType,
			),
		).toEqual(['quick-question.reply', 'quick-question.follow-up-reply'])
		expect(JSON.stringify(first)).not.toContain('csv@example.com')
	})

	it('previews matched purchaser value paths without raw email output or writes', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_matched_value_path',
				messageId: 'msg_matched_value_path',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'matched@example.com',
				text: 'I am a software engineer and developer. I want LLM fundamentals and tokens so I can build apps.',
			},
		})
		const before = JSON.stringify({
			states: Array.from(repository.states.entries()),
			nextActions: Array.from(repository.nextActions.entries()),
			sideEffectIntents: Array.from(repository.sideEffectIntents.entries()),
		})
		const purchaseRepository: PurchasePreviewRepository = {
			async findProductsByIds(productIds) {
				return productIds.map((id) => ({ id, name: 'AI SDK v6 Crash Course' }))
			},
			async findPurchasesByProductIds(_productIds) {
				return [
					{
						purchaseId: 'purchase_matched',
						productId: 'product-9wdta',
						productName: 'AI SDK v6 Crash Course',
						userId: 'user_matched',
						email: 'matched@example.com',
						createdAt: '2026-05-04T12:00:00.000Z',
						status: 'Valid',
						totalAmount: 149,
						country: 'US',
					},
				]
			},
		}

		const result = await previewMatchedPurchaserValuePaths({
			purchaseRepository,
			lookupRepository: new InMemoryOperatorLookupRepository(repository),
			quickQuestionCsv: [
				'Conversation ID,Message ID,Sender Email,Answer',
				'cnv_matched_value_path,msg_matched_value_path,matched@example.com,"I want LLM fundamentals"',
			].join('\n'),
			productIds: ['product-9wdta'],
		})

		expect(result.mode).toBe('matched-purchaser-value-path-preview')
		expect(result.privacy.rawEmailsIncluded).toBe(false)
		expect(result.matches.uniqueMatchedEmails).toBe(1)
		expect(result.matches.contactsFound).toBe(1)
		expect(result.candidates[0]?.domain).toBe('example.com')
		expect(result.candidates[0]?.matchedProducts[0]?.productId).toBe(
			'product-9wdta',
		)
		expect(result.candidates[0]?.valuePaths[0]?.path).toBe(
			'existing-customer-path',
		)
		expect(JSON.stringify(result)).not.toContain('matched@example.com')
		expect(
			JSON.stringify({
				states: Array.from(repository.states.entries()),
				nextActions: Array.from(repository.nextActions.entries()),
				sideEffectIntents: Array.from(repository.sideEffectIntents.entries()),
			}),
		).toBe(before)
	})

	it('previews replay without mutating repository records', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await dryRunSubscriberMarketingFixture({
			repository,
			fixture: supportFixture,
			now: '2026-05-04T13:00:00.000Z',
		})
		const before = {
			states: repository.states.size,
			transitions: repository.transitions.size,
			nextActions: repository.nextActions.size,
			sideEffectIntents: repository.sideEffectIntents.size,
			snapshot: JSON.stringify({
				states: Array.from(repository.states.entries()),
				transitions: Array.from(repository.transitions.entries()),
				nextActions: Array.from(repository.nextActions.entries()),
				sideEffectIntents: Array.from(repository.sideEffectIntents.entries()),
			}),
		}

		const replay = await previewSubscriberMarketingReplay({
			repository: new InMemoryOperatorLookupRepository(repository),
			contactId: result.contact.id,
			eventId: result.contactEvent.id,
			now: '2026-05-05T13:00:00.000Z',
		})

		expect(repository.states.size).toBe(before.states)
		expect(repository.transitions.size).toBe(before.transitions)
		expect(repository.nextActions.size).toBe(before.nextActions)
		expect(repository.sideEffectIntents.size).toBe(before.sideEffectIntents)
		expect(
			JSON.stringify({
				states: Array.from(repository.states.entries()),
				transitions: Array.from(repository.transitions.entries()),
				nextActions: Array.from(repository.nextActions.entries()),
				sideEffectIntents: Array.from(repository.sideEffectIntents.entries()),
			}),
		).toBe(before.snapshot)
		expect(replay.preview.nextAction.status).toBe('blocked')
		expect(
			replay.preview.nextAction.gates.find(
				(gate) => gate.slug === 'customer-visible-side-effects',
			)?.passed,
		).toBe(false)
		expect(replay.privacy.rawPayloadIncluded).toBe(false)
	})

	it('previews an individual AI SDK value path without writes', async () => {
		const result = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_value_ai_sdk',
				messageId: 'msg_value_ai_sdk',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'builder@example.com',
				text: 'I am a software engineer and developer. I want LLM fundamentals, tokens, models, and how it works so I can build an app product.',
			},
		})

		const preview = previewValuePath({
			state: result.contactState,
			recentEvents: [result.contactEvent],
		})

		expect(preview.mode).toBe('value-path-preview')
		expect(preview.nonSellableValuePaths).toContain('ai-hero-skills-workflow')
		expect(preview.nonSellableValuePaths).toContain(
			'ai-hero-skills-team-workflow',
		)
		expect(
			preview.contentResourceBackedValuePaths.map((path) => path.slug),
		).toEqual(['ai-hero-skills-workflow', 'ai-hero-skills-team-workflow'])
		expect(preview.candidate.path).toBe('ai-sdk-builder-path')
		expect(preview.candidate.metadata.contentResourceBackedPath).toBe(
			'ai-hero-skills-workflow',
		)
		expect(preview.candidate.offer).toBe('ai-sdk-v6-crash-course')
		expect(preview.candidate.status).toBe('review-only')
		expect(preview.candidate.metadata.kitWrites).toBe(false)
		expect(preview.candidate.metadata.frontWrites).toBe(false)
		expect(preview.candidate.metadata.sequenceEnrollment).toBe(false)
		expect(preview.candidate.metadata.contactStateWrite).toBe(false)
		expect(
			preview.candidate.gates.find(
				(gate) => gate.slug === 'customer-visible-side-effects',
			)?.passed,
		).toBe(false)
	})

	it('previews Claude Code for Real Engineers only as a teams 10+ human-review path', async () => {
		const result = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_value_team',
				messageId: 'msg_value_team',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'leader@example.com',
				text: 'I am a tech lead evaluating enterprise seats for a team of 12 engineers.',
			},
		})

		const preview = previewValuePath({
			state: result.contactState,
			recentEvents: [result.contactEvent],
		})

		expect(preview.candidate.path).toBe('team-enablement-path')
		expect(preview.candidate.metadata.contentResourceBackedPath).toBe(
			'ai-hero-skills-team-workflow',
		)
		expect(preview.candidate.offer).toBe('claude-code-real-engineers-team')
		expect(preview.candidate.status).toBe('human-review')
		expect(preview.candidate.metadata.teamSize).toBeGreaterThanOrEqual(10)
		expect(preview.candidate.rationale.join(' ')).toContain('teams 10+')
	})

	it('keeps small teams out of the Claude Code team offer', async () => {
		const result = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_value_small_team',
				messageId: 'msg_value_small_team',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'small-team@example.com',
				text: 'I am a tech lead buying seats for a team of 4 engineers.',
			},
		})

		const preview = previewValuePath({
			state: result.contactState,
			recentEvents: [result.contactEvent],
		})

		expect(preview.candidate.path).toBe('team-enablement-path')
		expect(preview.candidate.metadata.contentResourceBackedPath).toBe(
			'ai-hero-skills-team-workflow',
		)
		expect(preview.candidate.offer).toBeUndefined()
		expect(preview.candidate.status).toBe('human-review')
		expect(preview.candidate.reviewReasons).toContain(
			'team-size-not-qualified-or-unknown',
		)
	})

	it('does not pitch AI SDK v6 Crash Course to existing active buyers', async () => {
		const result = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_value_existing_buyer',
				messageId: 'msg_value_existing_buyer',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'existing@example.com',
				text: 'I am a software engineer and developer. I want LLM fundamentals and tokens so I can build apps.',
			},
		})

		const preview = previewValuePath({
			state: result.contactState,
			recentEvents: [result.contactEvent],
			purchaseFacts: [
				{
					productId: 'product-9wdta',
					productName: 'AI SDK v6 Crash Course',
					status: 'Valid',
					createdAt: '2026-05-04T14:00:00.000Z',
					totalAmount: 149,
				},
			],
		})

		expect(preview.candidate.path).toBe('existing-customer-path')
		expect(preview.candidate.offer).toBeUndefined()
		expect(preview.candidate.rationale.join(' ')).toContain(
			'do not pitch the same individual offer',
		)
	})

	it('suppresses or human-reviews refunded and support contacts', async () => {
		const builder = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_value_refunded',
				messageId: 'msg_value_refunded',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'refund@example.com',
				text: 'I am a software engineer and developer. I want to build apps with LLM fundamentals.',
			},
		})
		const refunded = previewValuePath({
			state: builder.contactState,
			recentEvents: [builder.contactEvent],
			purchaseFacts: [
				{
					productId: 'product-9wdta',
					productName: 'AI SDK v6 Crash Course',
					status: 'Refunded',
					createdAt: '2026-05-04T14:00:00.000Z',
					totalAmount: 149,
				},
			],
		})
		const support = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_value_support',
				messageId: 'msg_value_support',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'support-path@example.com',
				text: 'I need help with login access.',
			},
		})
		const supportPreview = previewValuePath({
			state: support.contactState,
			recentEvents: [support.contactEvent],
		})

		expect(refunded.candidate.path).toBe('suppress-do-not-market-path')
		expect(refunded.candidate.status).toBe('blocked')
		expect(supportPreview.candidate.path).toBe('support-access-issue-path')
		expect(supportPreview.candidate.status).toBe('human-review')
	})

	it('keeps vetoed membership and future catalog offers out of the catalog', () => {
		expect(SELLABLE_OFFERS.map((offer) => offer.slug)).toEqual([
			'ai-sdk-v6-crash-course',
			'claude-code-real-engineers-team',
		])
		expect(JSON.stringify(SELLABLE_OFFERS)).not.toContain('membership')
		expect(JSON.stringify(SELLABLE_OFFERS)).not.toContain('future')
	})

	it('previews Gate C shadow fields with only aih_ minimum fields', async () => {
		const result = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_shadow_fields',
				messageId: 'msg_shadow_fields',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'shadow@example.com',
				text: 'I am a software engineer and developer. I want LLM fundamentals, tokens, models, and how it works so I can build apps.',
			},
		})
		const valuePath = previewValuePath({
			state: result.contactState,
			recentEvents: [result.contactEvent],
		})

		const preview = previewShadowFields({
			contactId: result.contact.id,
			state: result.contactState,
			recentEvents: [result.contactEvent],
			valuePathCandidate: valuePath.candidate,
		})

		expect(preview.mode).toBe('shadow-field-preview')
		expect(Object.keys(preview.fields).sort()).toEqual(
			[...SHADOW_FIELD_KEYS].sort(),
		)
		expect(
			Object.keys(preview.fields).every((key) => key.startsWith('aih_')),
		).toBe(true)
		expect(preview.fields.aih_why_primary).toBe(
			'ai-fundamentals-under-the-hood',
		)
		expect(preview.fields.aih_who_primary).toBe(
			'professional-software-engineer',
		)
		expect(preview.fields.aih_human_review).toBe('false')
		expect(preview.fields.aih_next_action).toBe('review-shadow-fields')
		expect(preview.excludedFieldKeys).toEqual(EXCLUDED_CTA_FIELD_KEYS)
		expect(JSON.stringify(preview.fields)).not.toContain('aih_cta')
		expect(JSON.stringify(preview.fields)).not.toContain('aih_offer')
		expect(preview.metadata.kitWrites).toBe(false)
		expect(preview.metadata.customerVisibleSideEffects).toBe(false)
	})

	it('keeps human-review shadow previews safe and suppression-oriented', async () => {
		const support = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_shadow_support',
				messageId: 'msg_shadow_support',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'support-shadow@example.com',
				text: 'I need help with login access and invoices.',
			},
		})
		const preview = previewShadowFields({
			contactId: support.contact.id,
			state: support.contactState,
			recentEvents: [support.contactEvent],
		})

		expect(preview.status).toBe('human-review')
		expect(preview.fields.aih_human_review).toBe('true')
		expect(preview.fields.aih_review_reason).toContain('support')
		expect(preview.fields.aih_next_action).toBe('human-review')
		expect(preview.fields).not.toHaveProperty('aih_cta')
		expect(preview.fields).not.toHaveProperty('aih_offer')
		expect(
			preview.gates.find((gate) => gate.slug === 'human-review')?.passed,
		).toBe(false)
	})

	it('does not produce purchase CTA state for existing customers', async () => {
		const result = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_shadow_existing',
				messageId: 'msg_shadow_existing',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'existing-shadow@example.com',
				text: 'I am a software engineer. I want LLM fundamentals so I can build apps.',
			},
		})
		const valuePath = previewValuePath({
			state: result.contactState,
			recentEvents: [result.contactEvent],
			purchaseFacts: [
				{
					productId: 'product-9wdta',
					productName: 'AI SDK v6 Crash Course',
					status: 'Valid',
					createdAt: '2026-05-04T14:00:00.000Z',
					totalAmount: 149,
				},
			],
		})
		const preview = previewShadowFields({
			contactId: result.contact.id,
			state: result.contactState,
			recentEvents: [result.contactEvent],
			valuePathCandidate: valuePath.candidate,
		})

		expect(valuePath.candidate.path).toBe('existing-customer-path')
		expect(JSON.stringify(preview.fields)).not.toContain('purchase')
		expect(JSON.stringify(preview.fields)).not.toContain('product-9wdta')
		expect(preview.fields).not.toHaveProperty('aih_cta')
	})

	it('keeps low-confidence ambiguous shadow fields review-only and excludes raw identifiers', async () => {
		const result = await captureFrontQuickQuestion({
			repository: new InMemorySubscriberMarketingRepository(),
			input: {
				conversationId: 'cnv_shadow_low_confidence',
				messageId: 'msg_shadow_low_confidence',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'low-shadow@example.com',
				text: 'Thanks!',
			},
		})
		const preview = previewShadowFields({
			contactId: result.contact.id,
			state: result.contactState,
			recentEvents: [result.contactEvent],
		})

		expect(preview.status).toBe('human-review')
		expect(preview.fields.aih_review_reason).toContain('low-confidence')
		expect(preview.privacy.rawEmailsIncluded).toBe(false)
		expect(preview.privacy.rawPayloadIncluded).toBe(false)
		expect(JSON.stringify(preview)).not.toContain('low-shadow@example.com')
		expect(JSON.stringify(preview)).not.toContain('Thanks!')
	})

	it('lists clean shadow field candidates without raw identifiers', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const clean = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_shadow_candidate_clean',
				messageId: 'msg_shadow_candidate_clean',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'candidate-clean@example.com',
				text: 'I am a software engineer and developer. I want LLM fundamentals, tokens, and models so I can build apps.',
			},
		})
		const review = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_shadow_candidate_review',
				messageId: 'msg_shadow_candidate_review',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'candidate-review@example.com',
				text: 'Thanks!',
			},
		})
		const lookupRepository = new InMemoryOperatorLookupRepository(repository)
		const snapshots = await Promise.all(
			[clean.contact.id, review.contact.id].map((contactId) =>
				lookupSubscriberMarketingContact({
					repository: lookupRepository,
					input: { type: 'contact-id', contactId },
				}).then((lookup) => lookup.contacts[0]!),
			),
		)

		const candidates = previewShadowFieldCandidates({
			snapshots,
			status: 'review-only',
			noReviewReasons: true,
			limit: 10,
		})

		expect(candidates.mode).toBe('shadow-field-candidates')
		expect(candidates.counts.returned).toBe(1)
		expect(candidates.candidates[0]?.contactId).toBe(clean.contact.id)
		expect(candidates.candidates[0]?.reviewReasons).toEqual([])
		expect(candidates.candidates[0]?.fieldKeys.sort()).toEqual(
			[...SHADOW_FIELD_KEYS].sort(),
		)
		expect(JSON.stringify(candidates)).not.toContain(
			'candidate-clean@example.com',
		)
		expect(JSON.stringify(candidates)).not.toContain(
			'candidate-review@example.com',
		)
	})

	it('dry-runs Kit shadow field sync without writing', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_shadow_sync_dry_run',
				messageId: 'msg_shadow_sync_dry_run',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'sync-dry-run@example.com',
				text: 'I am a software engineer who wants LLM fundamentals for building apps.',
			},
		})
		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'contact-id', contactId: result.contact.id },
		})
		const updates: Record<string, string>[] = []
		const provider: KitShadowFieldProvider = {
			async getSubscriberByEmail() {
				return {
					id: 'kit_123',
					fields: {
						aih_confidence: '0.50',
						aih_review_reason: 'old raw email sync-dry-run@example.com',
					},
				}
			},
			async updateSubscriberFields({ fields }) {
				updates.push(fields)
				return { id: 'kit_123', fields }
			},
		}

		const sync = await syncShadowFieldsForContactSnapshot({
			snapshot: lookup.contacts[0]!,
			provider,
			allowWrite: false,
		})

		expect(sync.status).toBe('dry-run')
		expect(sync.kit.subscriberFound).toBe(true)
		expect(sync.kit.writeAttempted).toBe(false)
		expect(sync.kit.writePerformed).toBe(false)
		expect(sync.kit.beforeFields).toEqual({
			aih_confidence: '0.50',
			aih_review_reason: '[existing-value-present]',
		})
		expect(sync.kit.updatedFieldKeys.sort()).toEqual(
			[...SHADOW_FIELD_KEYS].sort(),
		)
		expect(updates).toHaveLength(0)
		expect(JSON.stringify(sync)).not.toContain('sync-dry-run@example.com')
	})

	it('allowlisted Kit shadow field sync writes only bounded aih fields', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_shadow_sync_write',
				messageId: 'msg_shadow_sync_write',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'sync-write@example.com',
				text: 'I am a software engineer and developer. I want LLM fundamentals, tokens, and models so I can build apps.',
			},
		})
		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'contact-id', contactId: result.contact.id },
		})
		const updates: Record<string, string>[] = []
		const provider: KitShadowFieldProvider = {
			async getSubscriberByEmail() {
				return { id: 'kit_456', fields: {} }
			},
			async updateSubscriberFields({ fields }) {
				updates.push(fields)
				return { id: 'kit_456', fields }
			},
		}

		const sync = await syncShadowFieldsForContactSnapshot({
			snapshot: lookup.contacts[0]!,
			provider,
			allowWrite: true,
		})

		expect(sync.status).toBe('written')
		expect(sync.kit.writeAttempted).toBe(true)
		expect(sync.kit.writePerformed).toBe(true)
		expect(sync.metadata.kitWrites).toBe(true)
		expect(updates).toHaveLength(1)
		expect(Object.keys(updates[0]!).sort()).toEqual(
			[...SHADOW_FIELD_KEYS].sort(),
		)
		expect(
			Object.keys(updates[0]!).every((key) => key.startsWith('aih_')),
		).toBe(true)
		expect(JSON.stringify(updates[0])).not.toContain('aih_cta')
		expect(JSON.stringify(updates[0])).not.toContain('aih_offer')
		expect(JSON.stringify(sync)).not.toContain('sync-write@example.com')
	})

	it('blocks human-review shadow field writes unless every review reason is accepted', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_shadow_sync_review_blocked',
				messageId: 'msg_shadow_sync_review_blocked',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'sync-review-blocked@example.com',
				text: 'I need help with login access and invoices.',
			},
		})
		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'contact-id', contactId: result.contact.id },
		})
		const updates: Record<string, string>[] = []
		const provider: KitShadowFieldProvider = {
			async getSubscriberByEmail() {
				return { id: 'kit_review_blocked', fields: {} }
			},
			async updateSubscriberFields({ fields }) {
				updates.push(fields)
				return { id: 'kit_review_blocked', fields }
			},
		}

		const blocked = await syncShadowFieldsForContactSnapshot({
			snapshot: lookup.contacts[0]!,
			provider,
			allowWrite: true,
		})

		expect(blocked.status).toBe('blocked')
		expect(blocked.preview.fields.aih_human_review).toBe('true')
		expect(blocked.preview.fields.aih_review_reason).toContain('support')
		expect(blocked.kit.writeAttempted).toBe(false)
		expect(blocked.kit.writePerformed).toBe(false)
		expect(blocked.metadata.kitWrites).toBe(false)
		expect(blocked.reviewReasons).toContain('support')
		expect(
			blocked.reviewReasons.some((reason) =>
				reason.startsWith('unaccepted-review-reason:'),
			),
		).toBe(true)
		expect(updates).toHaveLength(0)

		const accepted = await syncShadowFieldsForContactSnapshot({
			snapshot: lookup.contacts[0]!,
			provider,
			allowWrite: true,
			acceptedReviewReasons: blocked.preview.reviewReasons,
		})

		expect(accepted.status).toBe('written')
		expect(accepted.preview.fields.aih_human_review).toBe('true')
		expect(accepted.preview.fields.aih_review_reason).toContain('support')
		expect(accepted.kit.writeAttempted).toBe(true)
		expect(accepted.kit.writePerformed).toBe(true)
		expect(accepted.metadata.kitWrites).toBe(true)
		expect(updates).toHaveLength(1)
		expect(updates[0]?.aih_human_review).toBe('true')
		expect(updates[0]?.aih_review_reason).toContain('support')
		expect(Object.keys(updates[0]!).sort()).toEqual(
			[...SHADOW_FIELD_KEYS].sort(),
		)
	})

	it('requires tiny explicit limits for Content Read allow-write batches', () => {
		expect(() =>
			validateContentReadAllowWriteOptions({
				allowWrite: true,
				limit: 100,
				limitProvided: false,
			}),
		).toThrow(/requires an explicit --limit/)
		expect(() =>
			validateContentReadAllowWriteOptions({
				allowWrite: true,
				limit: 25,
				limitProvided: true,
			}),
		).toThrow(/too large/)
		expect(() =>
			validateContentReadAllowWriteOptions({
				allowWrite: true,
				limit: 5,
				limitProvided: true,
			}),
		).not.toThrow()
		expect(() =>
			validateContentReadAllowWriteOptions({
				allowWrite: true,
				limit: 25,
				limitProvided: true,
				forceLargeWrite: true,
			}),
		).not.toThrow()
	})

	it('previews logged-in Content Reads as eligible content.read Contact Events without writes', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: 'user_content_read',
			email: 'reader@example.com',
			name: 'Reader',
			lifecycle: 'new',
			isProvisional: false,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		const identity = repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: 'user_content_read',
			evidence: {
				email: 'reader@example.com',
				userId: 'user_content_read',
				providerIdentity: {
					provider: 'ai-hero',
					externalId: 'user_content_read',
				},
				source: 'ai-hero',
				strength: 'strong',
			},
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})

		const preview = await previewContentReadContactEvent(repository, {
			id: 'content_read_1',
			sessionId: 'aih_session_1',
			userId: 'user_content_read',
			contentId: 'post_1',
			contentSlug: 'ship-your-first-ai-feature',
			contentType: 'post',
			readSignal: 'dwell_30s',
			contentMetadata: { title: 'Ship Your First AI Feature' },
			pathname: '/posts/ship-your-first-ai-feature',
			semanticIdempotencyKey:
				'content-read:v1:user_content_read:post:post_1:dwell_30s:2026-05-11',
			occurredAt: '2026-05-11T12:05:00.000Z',
		})

		expect(preview.status).toBe('eligible')
		if (preview.status !== 'eligible')
			throw new Error('expected eligible preview')
		expect(preview.contactId).toBe(contact.id)
		expect(preview.providerIdentityId).toBe(identity.id)
		expect(preview.wouldCreate.eventType).toBe('content.read')
		expect(preview.wouldCreate.payloadSummary.summary).toContain(
			'Ship Your First AI Feature',
		)
		expect(repository.contactEvents.size).toBe(0)
	})

	it('writes eligible Content Read Contact Events only with explicit write helper', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: 'user_write_read',
			email: 'write-reader@example.com',
			name: null,
			lifecycle: 'new',
			isProvisional: false,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: 'user_write_read',
			evidence: {
				userId: 'user_write_read',
				providerIdentity: {
					provider: 'ai-hero',
					externalId: 'user_write_read',
				},
				source: 'ai-hero',
				strength: 'strong',
			},
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})

		const result = await writeContentReadContactEvents({
			repository,
			now: '2026-05-11T12:35:00.000Z',
			rows: [
				{
					id: 'content_read_write',
					sessionId: 'aih_session_write',
					userId: 'user_write_read',
					contentId: 'post_write',
					contentSlug: 'write-read',
					contentType: 'post',
					readSignal: 'cta_click',
					pathname: '/posts/write-read',
					semanticIdempotencyKey:
						'content-read:v1:user_write_read:post:post_write:cta_click:2026-05-11',
					occurredAt: '2026-05-11T12:34:00.000Z',
				},
				{
					id: 'content_read_write_anon',
					sessionId: 'aih_session_write_anon',
					contentId: 'post_write_anon',
					contentSlug: 'write-read-anon',
					contentType: 'post',
					readSignal: 'dwell_30s',
					pathname: '/posts/write-read-anon',
					semanticIdempotencyKey:
						'content-read:v1:aih_session_write_anon:post:post_write_anon:dwell_30s:2026-05-11',
					occurredAt: '2026-05-11T12:34:00.000Z',
				},
			],
		})

		expect(result.mode).toBe('write')
		expect(result.writtenCount).toBe(1)
		expect(result.skippedByReason['anonymous-session-only']).toBe(1)
		expect(result.customerVisibleSideEffects).toBe(false)
		expect(result.kitWrites).toBe(false)
		expect(result.sequenceEnrollments).toBe(false)
		expect(result.contactStateWrites).toBe(false)
		expect(repository.contactEvents.size).toBe(1)
		expect(repository.states.size).toBe(0)
	})

	it('keeps Content Read write path idempotent across repeated runs', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const row = {
			id: 'content_read_idempotent',
			sessionId: 'aih_session_idempotent',
			userId: 'user_idempotent_read',
			contentId: 'post_idempotent',
			contentSlug: 'idempotent-read',
			contentType: 'post',
			readSignal: 'dwell_30s',
			pathname: '/posts/idempotent-read',
			semanticIdempotencyKey:
				'content-read:v1:user_idempotent_read:post:post_idempotent:dwell_30s:2026-05-11',
			occurredAt: '2026-05-11T12:34:00.000Z',
		}

		const first = await writeContentReadContactEvents({
			repository,
			now: '2026-05-11T12:35:00.000Z',
			rows: [row],
		})
		const second = await writeContentReadContactEvents({
			repository,
			now: '2026-05-11T12:36:00.000Z',
			rows: [row],
		})

		expect(first.writtenCount).toBe(1)
		expect(second.writtenCount).toBe(0)
		expect(second.skippedByReason['duplicate-semantic-key']).toBe(1)
		expect(repository.contactEvents.size).toBe(1)
		expect(repository.states.size).toBe(0)
		expect(first.customerVisibleSideEffects).toBe(false)
		expect(second.customerVisibleSideEffects).toBe(false)
	})

	it('links logged-in AI Hero users from Content Reads to provisional Contacts', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await linkAiHeroUserIdentities({
			repository,
			userIds: ['user_linked_read'],
			now: '2026-05-11T12:01:00.000Z',
		})
		const preview = await previewContentReadContactEvent(repository, {
			id: 'content_read_user_linked',
			sessionId: 'aih_session_user_linked',
			userId: 'user_linked_read',
			contentId: 'post_user_linked',
			contentSlug: 'user-linked',
			contentType: 'post',
			readSignal: 'dwell_30s',
			pathname: '/posts/user-linked',
			semanticIdempotencyKey:
				'content-read:v1:user_linked_read:post:post_user_linked:dwell_30s:2026-05-11',
			occurredAt: '2026-05-11T12:34:00.000Z',
		})

		expect(result.linkedCount).toBe(1)
		expect(result.customerVisibleSideEffects).toBe(false)
		expect(repository.contacts.size).toBe(1)
		expect(
			repository.findProviderIdentity('ai-hero', 'user_linked_read'),
		).toBeTruthy()
		expect(preview.status).toBe('eligible')
	})

	it('does not duplicate existing AI Hero user identity links', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		await linkAiHeroUserIdentities({
			repository,
			userIds: ['user_existing_link'],
		})
		const second = await linkAiHeroUserIdentities({
			repository,
			userIds: ['user_existing_link'],
		})

		expect(second.linkedCount).toBe(0)
		expect(second.skippedCount).toBe(1)
		expect(second.results[0]?.status).toBe('skipped')
		expect(repository.providerIdentities.size).toBe(1)
	})

	it('links trusted Kit subscribers to existing Contacts by verified subscriber email', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const existingContact = repository.createContact({
			userId: null,
			email: 'kit-link@example.com',
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})

		const result = await linkKitSubscriberIdentities({
			repository,
			kitSubscriberIds: ['kit_link_1'],
			now: '2026-05-11T12:01:00.000Z',
			kit: {
				async getSubscriber(id) {
					return {
						id,
						email_address: 'kit-link@example.com',
						first_name: 'Kit',
					}
				},
			},
		})

		expect(result.linkedCount).toBe(1)
		expect(result.kitWrites).toBe(false)
		expect(repository.contacts.size).toBe(1)
		expect(
			repository.findProviderIdentity('kit', 'kit_link_1')?.contactId,
		).toBe(existingContact.id)
	})

	it('skips Kit subscriber identity linking when subscriber email is missing', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await linkKitSubscriberIdentities({
			repository,
			kitSubscriberIds: ['kit_missing_email'],
			kit: {
				async getSubscriber(id) {
					return { id, email_address: null }
				},
			},
		})

		expect(result.linkedCount).toBe(0)
		expect(result.skippedCount).toBe(1)
		expect(result.results[0]?.status).toBe('skipped')
		expect(
			result.results[0]?.status === 'skipped' && result.results[0].reason,
		).toBe('subscriber-email-missing')
		expect(repository.providerIdentities.size).toBe(0)
	})

	it('previews Kit subscriber Content Reads only when Kit identity already exists', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: null,
			email: 'kit-reader@example.com',
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'kit',
			externalId: 'kit_123',
			evidence: {
				email: 'kit-reader@example.com',
				providerIdentity: { provider: 'kit', externalId: 'kit_123' },
				source: 'kit',
				strength: 'strong',
			},
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})

		const preview = await previewContentReadContactEvent(repository, {
			id: 'content_read_kit',
			sessionId: 'aih_session_kit',
			kitSubscriberId: 'kit_123',
			contentId: 'post_kit',
			contentSlug: 'ai-coding-workflows',
			contentType: 'post',
			readSignal: 'scroll_50',
			contentMetadata: { title: 'AI Coding Workflows' },
			pathname: '/posts/ai-coding-workflows',
			semanticIdempotencyKey:
				'content-read:v1:kit_123:post:post_kit:scroll_50:2026-05-11',
			occurredAt: '2026-05-11T12:10:00.000Z',
		})

		expect(preview.status).toBe('eligible')
		if (preview.status !== 'eligible')
			throw new Error('expected eligible preview')
		expect(preview.identityResolutionPath).toBe(
			'kit-subscriber-existing-provider-identity',
		)
		expect(preview.wouldCreate.identityEvidence.source).toBe('kit')
	})

	it('keeps anonymous and hash-only Content Reads staged in preview', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const anonymous = await previewContentReadContactEvent(repository, {
			id: 'content_read_anon',
			sessionId: 'aih_session_anon',
			contentId: 'post_anon',
			contentSlug: 'anonymous-read',
			contentType: 'post',
			readSignal: 'dwell_30s',
			pathname: '/posts/anonymous-read',
			semanticIdempotencyKey:
				'content-read:v1:aih_session_anon:post:post_anon:dwell_30s:2026-05-11',
			occurredAt: '2026-05-11T12:15:00.000Z',
		})
		const hashOnly = await previewContentReadContactEvent(repository, {
			id: 'content_read_hash',
			sessionId: 'aih_session_hash',
			emailSha256:
				'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			contentId: 'post_hash',
			contentSlug: 'hash-read',
			contentType: 'post',
			readSignal: 'dwell_30s',
			pathname: '/posts/hash-read',
			semanticIdempotencyKey:
				'content-read:v1:hash:post:post_hash:dwell_30s:2026-05-11',
			occurredAt: '2026-05-11T12:20:00.000Z',
		})

		expect(anonymous.status).toBe('skipped')
		expect(anonymous.status === 'skipped' && anonymous.reason).toBe(
			'anonymous-session-only',
		)
		expect(hashOnly.status).toBe('skipped')
		expect(hashOnly.status === 'skipped' && hashOnly.reason).toBe(
			'email-hash-unresolved',
		)
	})

	it('skips duplicate semantic keys during Content Read preview', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: 'user_duplicate_read',
			email: null,
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		const identity = repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: 'user_duplicate_read',
			evidence: {
				userId: 'user_duplicate_read',
				providerIdentity: {
					provider: 'ai-hero',
					externalId: 'user_duplicate_read',
				},
				source: 'ai-hero',
				strength: 'strong',
			},
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		repository.createContactEvent({
			contactId: contact.id,
			providerIdentityId: identity.id,
			provider: 'ai-hero',
			providerEventId: 'content-read:existing',
			providerReference: 'ai-hero:content-read:existing',
			eventType: 'content.read',
			occurredAt: '2026-05-11T12:00:00.000Z',
			semanticIdempotencyKey:
				'ai-hero:content.read:content-read:v1:user_duplicate_read:post:post_duplicate:dwell_30s:2026-05-11',
			privacyLevel: 'internal',
			identityEvidence: identity.evidence,
			payloadSummary: {
				summary: 'Existing event',
				keywords: [],
				restrictedPayloadStored: false,
			},
			schemaVersion: 1,
		})

		const preview = await previewContentReadContactEvent(repository, {
			id: 'content_read_duplicate',
			sessionId: 'aih_session_duplicate',
			userId: 'user_duplicate_read',
			contentId: 'post_duplicate',
			contentSlug: 'duplicate-read',
			contentType: 'post',
			readSignal: 'dwell_30s',
			pathname: '/posts/duplicate-read',
			semanticIdempotencyKey:
				'content-read:v1:user_duplicate_read:post:post_duplicate:dwell_30s:2026-05-11',
			occurredAt: '2026-05-11T12:00:00.000Z',
		})

		expect(preview.status).toBe('skipped')
		expect(preview.status === 'skipped' && preview.reason).toBe(
			'duplicate-semantic-key',
		)
	})

	it('previews Seen Content keys from Contact Events without Kit writes', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: null,
			email: 'seen@example.com',
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		const identity = repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: 'user_seen',
			evidence: {
				userId: 'user_seen',
				providerIdentity: { provider: 'ai-hero', externalId: 'user_seen' },
				source: 'ai-hero',
				strength: 'strong',
			},
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		const grill = repository.createContactEvent({
			contactId: contact.id,
			providerIdentityId: identity.id,
			provider: 'ai-hero',
			providerEventId: 'content-read:seen-grill',
			providerReference: 'ai-hero:content-read:seen-grill',
			eventType: 'content.read',
			occurredAt: '2026-05-11T12:00:00.000Z',
			semanticIdempotencyKey: 'seen-grill',
			privacyLevel: 'internal',
			identityEvidence: identity.evidence,
			payloadSummary: {
				summary: 'Read signal scroll_50 for The /grill-me Skill',
				keywords: ['content-read', 'scroll_50', 'grill-me'],
				restrictedPayloadStored: false,
			},
			schemaVersion: 1,
		})
		const dictionary = repository.createContactEvent({
			contactId: contact.id,
			providerIdentityId: identity.id,
			provider: 'ai-hero',
			providerEventId: 'shortlink-click:seen-dictionary',
			providerReference: 'ai-hero:shortlink-click:seen-dictionary',
			eventType: 'shortlink.click',
			occurredAt: '2026-05-11T12:01:00.000Z',
			semanticIdempotencyKey: 'seen-dictionary',
			privacyLevel: 'internal',
			identityEvidence: identity.evidence,
			payloadSummary: {
				summary: 'Clicked shortlink dictionary; content ai-coding-dictionary',
				keywords: ['shortlink-click', 'ai-coding-dictionary'],
				restrictedPayloadStored: false,
			},
			schemaVersion: 1,
		})

		const preview = previewSeenContent({
			contactId: contact.id,
			events: [dictionary, grill],
			now: '2026-05-11T12:02:00.000Z',
		})

		expect(preview.seenContentKeys).toBe('ai-coding-dictionary|grill-me')
		expect(preview.items[1]?.strongestSeenLevel).toBe('scrolled')
		expect(preview.items[0]?.strongestSeenLevel).toBe('clicked')
		expect(preview.kitWrites).toBe(false)
		expect(preview.customerVisibleSideEffects).toBe(false)
	})

	it('dry-runs Kit Seen Content projection without writing', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: null,
			email: 'seen-dry-run@example.com',
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		const identity = repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'ai-hero',
			externalId: 'user_seen_dry_run',
			evidence: {
				email: 'seen-dry-run@example.com',
				providerIdentity: {
					provider: 'ai-hero',
					externalId: 'user_seen_dry_run',
				},
				source: 'ai-hero',
				strength: 'strong',
			},
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		repository.createContactEvent({
			contactId: contact.id,
			providerIdentityId: identity.id,
			provider: 'ai-hero',
			providerEventId: 'content-read:seen-dry-run-grill',
			providerReference: 'ai-hero:content-read:seen-dry-run-grill',
			eventType: 'content.read',
			occurredAt: '2026-05-11T12:00:00.000Z',
			semanticIdempotencyKey: 'seen-dry-run-grill',
			privacyLevel: 'internal',
			identityEvidence: identity.evidence,
			payloadSummary: {
				summary: 'Read signal scroll_50 for The /grill-me Skill',
				keywords: ['content-read', 'scroll_50', 'grill-me'],
				restrictedPayloadStored: false,
			},
			schemaVersion: 1,
		})
		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'contact-id', contactId: contact.id },
		})
		const updates: Record<string, string>[] = []
		const provider: KitSeenContentProvider = {
			async getSubscriberByEmail() {
				return {
					id: 'kit_seen_dry_run',
					fields: {
						aih_seen_content_keys: 'old-key',
						aih_seen_content_updated_at: '2026-05-10T00:00:00.000Z',
					},
				}
			},
			async updateSubscriberFields({ fields }) {
				updates.push(fields)
				return { id: 'kit_seen_dry_run', fields }
			},
		}

		const sync = await syncSeenContentKitFieldsForContactSnapshot({
			snapshot: lookup.contacts[0]!,
			provider,
			allowWrite: false,
			now: '2026-05-11T12:02:00.000Z',
		})

		expect(sync.status).toBe('dry-run')
		expect(sync.fields).toEqual({
			aih_seen_content_keys: 'grill-me',
			aih_seen_content_updated_at: '2026-05-11T12:02:00.000Z',
		})
		expect(sync.kit.writeAttempted).toBe(false)
		expect(sync.kit.writePerformed).toBe(false)
		expect(sync.kit.updatedFieldKeys.sort()).toEqual(
			[...SEEN_CONTENT_KIT_FIELD_KEYS].sort(),
		)
		expect(sync.metadata.kitWrites).toBe(false)
		expect(updates).toHaveLength(0)
		expect(JSON.stringify(sync)).not.toContain('seen-dry-run@example.com')
	})

	it('allowlisted Kit Seen Content projection writes only projection fields', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: null,
			email: 'seen-write@example.com',
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		const identity = repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'kit',
			externalId: 'kit_seen_write',
			evidence: {
				email: 'seen-write@example.com',
				providerIdentity: { provider: 'kit', externalId: 'kit_seen_write' },
				source: 'kit',
				strength: 'strong',
			},
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		for (let index = 0; index < 25; index++) {
			repository.createContactEvent({
				contactId: contact.id,
				providerIdentityId: identity.id,
				provider: 'kit',
				providerEventId: `shortlink-click:seen-write-${index}`,
				providerReference: `kit:shortlink-click:seen-write-${index}`,
				eventType: 'shortlink.click',
				occurredAt: `2026-05-11T12:${String(index).padStart(2, '0')}:00.000Z`,
				semanticIdempotencyKey: `seen-write-${index}`,
				privacyLevel: 'internal',
				identityEvidence: identity.evidence,
				payloadSummary: {
					summary: 'Clicked shortlink with explicit seen content key',
					keywords: ['shortlink-click'],
					restrictedPayloadStored: false,
					seenContentKey: index % 2 === 0 ? 'my-claw' : 'is-code-cheap',
				} as any,
				schemaVersion: 1,
			})
		}
		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'contact-id', contactId: contact.id },
			limit: 100,
		})
		const updates: Record<string, string>[] = []
		const provider: KitSeenContentProvider = {
			async getSubscriberByEmail() {
				return { id: 'kit_seen_write', fields: {} }
			},
			async updateSubscriberFields({ fields }) {
				updates.push(fields)
				return { id: 'kit_seen_write', fields }
			},
		}

		const sync = await syncSeenContentKitFieldsForContactSnapshot({
			snapshot: lookup.contacts[0]!,
			provider,
			allowWrite: true,
			now: '2026-05-11T12:30:00.000Z',
		})

		expect(sync.status).toBe('written')
		expect(sync.fields.aih_seen_content_keys).toBe('is-code-cheap|my-claw')
		expect(
			sync.fields.aih_seen_content_keys.split('|').length,
		).toBeLessThanOrEqual(20)
		expect(sync.fields.aih_seen_content_updated_at).toBe(
			'2026-05-11T12:30:00.000Z',
		)
		expect(sync.kit.writeAttempted).toBe(true)
		expect(sync.kit.writePerformed).toBe(true)
		expect(sync.metadata.kitWrites).toBe(true)
		expect(sync.metadata.sequenceEnrollment).toBe(false)
		expect(sync.metadata.customerVisibleSideEffects).toBe(false)
		expect(updates).toHaveLength(1)
		expect(Object.keys(updates[0]!).sort()).toEqual(
			[...SEEN_CONTENT_KIT_FIELD_KEYS].sort(),
		)
		expect(JSON.stringify(updates[0])).not.toContain('aih_cta')
		expect(JSON.stringify(updates[0])).not.toContain('aih_offer')
		expect(JSON.stringify(sync)).not.toContain('seen-write@example.com')
	})

	it('renders a minimal ELI5 review page from preview output', async () => {
		const preview = await previewContentReadContactEvents({
			repository: new InMemorySubscriberMarketingRepository(),
			rows: [
				{
					id: 'content_read_review_page',
					sessionId: 'aih_session_review_page',
					contentId: 'post_review_page',
					contentSlug: 'review-page',
					contentType: 'post',
					readSignal: 'dwell_30s',
					pathname: '/posts/review-page',
					semanticIdempotencyKey:
						'content-read:v1:aih_session_review_page:post:post_review_page:dwell_30s:2026-05-11',
					occurredAt: '2026-05-11T12:34:00.000Z',
				},
			],
		})
		const html = renderContactEventReviewHtml({
			title: 'AIH-133 Review',
			sourceTable: 'AI_ContentRead',
			preview,
		})

		expect(html).toContain('Do this')
		expect(html).toContain('AI_ContentRead')
		expect(html).toContain('They are not logs')
		expect(html).toContain('Do not write yet')
	})

	it('builds a redacted production receipt from preview and retention counts', async () => {
		const preview = await previewContentReadContactEvents({
			repository: new InMemorySubscriberMarketingRepository(),
			rows: [],
		})
		const receipt = buildContactEventProductionReceipt({
			preview,
			retention: {
				retentionDays: 14,
				cutoff: '2026-05-01T00:00:00.000Z',
				candidateCount: 2,
			},
		})

		expect(receipt.mode).toBe('read-only')
		expect(receipt.tables).toContain('AI_ContentRead')
		expect(receipt.retentionCandidates?.candidateCount).toBe(2)
		expect(receipt.safety.identityValuesRedacted).toBe(true)
		expect(receipt.safety.writesPerformed).toBe(false)
	})

	it('summarizes shortlink click metadata without raw payload blobs', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: null,
			email: 'clicker@example.com',
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'kit',
			externalId: 'kit_clicker',
			evidence: {
				email: 'clicker@example.com',
				providerIdentity: { provider: 'kit', externalId: 'kit_clicker' },
				source: 'kit',
				strength: 'strong',
			},
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})

		const preview = await previewShortlinkClickContactEvent(repository, {
			id: 'click_1',
			shortlinkId: 'shortlink_1',
			slug: 'ai-feature',
			timestamp: '2026-05-11T12:30:00.000Z',
			metadata: {
				kitSubscriberId: 'kit_clicker',
				campaign: 'cohort-004',
				contentSlug: 'ship-your-first-ai-feature',
				rawPayload: 'do not include this raw blob',
			},
		})

		expect(preview.status).toBe('eligible')
		if (preview.status !== 'eligible')
			throw new Error('expected eligible preview')
		expect(preview.wouldCreate.eventType).toBe('shortlink.click')
		expect(preview.wouldCreate.payloadSummary.summary).toContain('cohort-004')
		expect(JSON.stringify(preview.wouldCreate.payloadSummary)).not.toContain(
			'do not include this raw blob',
		)
	})

	it('previews shortlink clicks from allowlisted shortlink metadata fields', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const contact = repository.createContact({
			userId: null,
			email: 'shortlink@example.com',
			name: null,
			lifecycle: 'new',
			isProvisional: true,
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})
		repository.createProviderIdentity({
			contactId: contact.id,
			provider: 'kit',
			externalId: 'kit_shortlink',
			evidence: {
				email: 'shortlink@example.com',
				providerIdentity: { provider: 'kit', externalId: 'kit_shortlink' },
				source: 'kit',
				strength: 'strong',
			},
			createdAt: '2026-05-11T12:00:00.000Z',
			updatedAt: '2026-05-11T12:00:00.000Z',
		})

		const preview = await previewShortlinkClickContactEvent(repository, {
			id: 'click_metadata',
			shortlinkId: 'shortlink_metadata',
			slug: 'metadata-click',
			timestamp: '2026-05-11T12:30:00.000Z',
			metadata: { kitSubscriberId: 'kit_shortlink' },
			shortlinkMetadata: {
				campaignSlug: 'cohort-004',
				resourceSlug: 'dictionary',
				utm_source: 'kit',
				privateNotes: 'do not copy',
			},
		})

		expect(preview.status).toBe('eligible')
		if (preview.status !== 'eligible')
			throw new Error('expected eligible preview')
		expect(preview.wouldCreate.payloadSummary.summary).toContain('cohort-004')
		expect(preview.wouldCreate.payloadSummary.summary).toContain('dictionary')
		expect(JSON.stringify(preview.wouldCreate.payloadSummary)).not.toContain(
			'do not copy',
		)
	})

	it('blocks shadow field sync when no Kit subscriber is found', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		const result = await captureFrontQuickQuestion({
			repository,
			input: {
				conversationId: 'cnv_shadow_sync_missing',
				messageId: 'msg_shadow_sync_missing',
				messageCreatedAt: '2026-05-04T14:00:00.000Z',
				senderEmail: 'missing-kit@example.com',
				text: 'I want LLM fundamentals for building apps.',
			},
		})
		const lookup = await lookupSubscriberMarketingContact({
			repository: new InMemoryOperatorLookupRepository(repository),
			input: { type: 'contact-id', contactId: result.contact.id },
		})
		const sync = await syncShadowFieldsForContactSnapshot({
			snapshot: lookup.contacts[0]!,
			provider: {
				async getSubscriberByEmail() {
					return null
				},
			},
			allowWrite: true,
		})

		expect(sync.status).toBe('blocked')
		expect(sync.kit.lookupPerformed).toBe(true)
		expect(sync.kit.subscriberFound).toBe(false)
		expect(sync.kit.writeAttempted).toBe(false)
		expect(sync.reviewReasons).toContain('kit-subscriber-not-found')
	})

	it('builds team Kit projections for owners, members, and seat counts', () => {
		const ownerPurchases: TeamPurchaseRow[] = [
			teamPurchaseRow({
				purchaseId: 'purchase_owner',
				email: 'owner@example.com',
				teamId: 'bulk_123',
				couponMaxUses: 10,
				couponUsedCount: 4,
				purchaseCreatedAt: '2026-05-20T10:00:00.000Z',
			}),
		]
		const memberPurchases: TeamPurchaseRow[] = [
			teamPurchaseRow({
				purchaseId: 'purchase_member',
				email: 'member@example.com',
				teamId: 'bulk_123',
				couponMaxUses: 10,
				couponUsedCount: 4,
				purchaseCreatedAt: '2026-05-21T10:00:00.000Z',
			}),
			teamPurchaseRow({
				purchaseId: 'purchase_owner_member',
				email: 'owner@example.com',
				teamId: 'bulk_123',
				couponMaxUses: 10,
				couponUsedCount: 4,
				purchaseCreatedAt: '2026-05-22T10:00:00.000Z',
			}),
		]
		const skipped: any[] = []

		const contacts = buildTeamKitProjectionContacts({
			ownerPurchases,
			memberPurchases,
			skipped,
		})

		const owner = contacts.find(
			(contact) => contact.email === 'owner@example.com',
		)
		const member = contacts.find(
			(contact) => contact.email === 'member@example.com',
		)
		expect(owner?.role).toBe('owner_member')
		expect(owner?.fields.aih_team_role).toBe('owner_member')
		expect(owner?.fields.aih_team_seat_count).toBe('10')
		expect(owner?.fields.aih_team_used_seat_count).toBe('4')
		expect(member?.role).toBe('member')
		expect(member?.fields.aih_team_ids).toBe('bulk_123')
		expect(skipped).toHaveLength(0)
	})

	it('dry-runs and writes team Kit projections with owner and member tags', async () => {
		const ownerPurchases = [
			teamPurchaseRow({
				purchaseId: 'purchase_owner',
				email: 'owner@example.com',
				teamId: 'bulk_owner',
				couponMaxUses: 10,
				couponUsedCount: 3,
			}),
		]
		const memberPurchases = [
			teamPurchaseRow({
				purchaseId: 'purchase_member',
				email: 'member@example.com',
				teamId: 'bulk_owner',
				couponMaxUses: 10,
				couponUsedCount: 3,
			}),
		]
		const updatedFields: Record<string, string>[] = []
		const tagged: string[] = []
		const provider: TeamKitProjectionProvider = {
			async getSubscriberByEmail(email) {
				return { id: `kit_${email}`, fields: {} }
			},
			async updateSubscriberFields({ fields }) {
				updatedFields.push(fields)
				return { id: 'updated' }
			},
			async subscribeToList({ listId }) {
				tagged.push(String(listId))
				return { ok: true }
			},
		}

		const dryRun = await previewTeamKitProjection({
			ownerPurchases,
			memberPurchases,
			provider,
			allowWrite: false,
		})

		expect(dryRun.status).toBe('dry-run')
		expect(dryRun.counts.ownerPurchases).toBe(1)
		expect(dryRun.counts.memberPurchases).toBe(1)
		expect(dryRun.counts.fieldWritesPerformed).toBe(0)
		expect(updatedFields).toHaveLength(0)
		expect(tagged).toHaveLength(0)

		const written = await previewTeamKitProjection({
			ownerPurchases,
			memberPurchases,
			provider,
			allowWrite: true,
			ownerTagId: 'tag_owner',
			memberTagId: 'tag_member',
		})

		expect(written.status).toBe('written')
		expect(written.counts.fieldWritesPerformed).toBe(2)
		expect(written.counts.tagWritesPerformed).toBe(2)
		expect(updatedFields).toHaveLength(2)
		expect(tagged.sort()).toEqual(['tag_member', 'tag_owner'])
	})
})

/**
 * Builds a default TeamPurchaseRow fixture for tests, merging any provided overrides.
 *
 * @param overrides - Partial fields to merge into the default fixture
 * @returns A complete TeamPurchaseRow with sensible defaults
 */
function teamPurchaseRow(overrides: Partial<TeamPurchaseRow>): TeamPurchaseRow {
	return {
		purchaseId: 'purchase_1',
		userId: 'user_1',
		email: 'person@example.com',
		name: 'Person Example',
		teamId: 'bulk_1',
		productId: 'product_1',
		productName: 'AI Hero Product',
		productSlug: 'ai-hero-product',
		purchaseCreatedAt: '2026-05-20T10:00:00.000Z',
		couponMaxUses: 5,
		couponUsedCount: 2,
		...overrides,
	}
}
