import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildSkillsCourseLessonOneEmail } from './lesson-one-email'
import {
	runSupportSkillsLessonOneRecovery,
	type RecoveryIntent,
	type RecoveryProviderMessage,
	type RecoveryProviderSendResult,
	type SkillsLessonOneRecoveryCommand,
	type SkillsLessonOneRecoveryDependencies,
} from './support-lesson-one-recovery'

const FIXED_NOW = new Date('2026-09-03T18:00:00.000Z')
const IDENTITY = {
	email: 'learner@example.com',
	kitSubscriberId: 'kit_41',
}
const AUDIT = {
	runId: 'support_run_1',
	conversationId: 'conversation_1',
	operatorId: 'operator_1',
	approvalReference: 'approved_by_operator',
	expectedInboundId: 'inbound_1',
}
const EMAIL = buildSkillsCourseLessonOneEmail({
	aih_value_path_answer_links_json: JSON.stringify([
		{ optionValue: 'personal', href: 'https://example.com/personal' },
		{ optionValue: 'team', href: 'https://example.com/team' },
		{ optionValue: 'unsure', href: 'https://example.com/unsure' },
	]),
})

type Harness = ReturnType<typeof createHarness>

function previewCommand(): SkillsLessonOneRecoveryCommand {
	return {
		operation: 'preview',
		identity: IDENTITY,
		recoveryId: 'skills-lesson-one-case-1',
		audit: AUDIT,
	}
}

function createHarness() {
	let intent: RecoveryIntent | null = null
	let providerMessage: RecoveryProviderMessage | null = null
	const writes: string[] = []
	const send = vi.fn(async (): Promise<RecoveryProviderSendResult> => {
		expect(intent?.status).toBe('sending')
		return { state: 'accepted', messageId: 'message_1' }
	})
	const findByRecoveryKey = vi.fn(async () => providerMessage)
	const read = vi.fn(async (messageId: string) => {
		return providerMessage?.messageId === messageId ? providerMessage : null
	})

	const dependencies: SkillsLessonOneRecoveryDependencies = {
		subscribers: {
			findByEmail: vi.fn(async () => ({
				state: 'found' as const,
				id: IDENTITY.kitSubscriberId,
				email: IDENTITY.email,
				subscriberState: 'active',
			})),
		},
		store: {
			findContext: vi.fn(async () => ({
				contactId: 'contact_41',
				sourceIntentId: 'source_intent_1',
				sourceNextActionId: 'source_action_1',
				sourceKitSubscriberId: IDENTITY.kitSubscriberId,
			})),
			findIntent: vi.fn(async () => intent),
			createIntent: vi.fn(async (input) => {
				writes.push('create-pending')
				intent = {
					id: 'recovery_intent_1',
					contactId: input.contactId,
					status: 'pending',
					completedAt: null,
					metadata: {
						providerRecoveryKey: input.providerRecoveryKey,
						recipientHash: input.recipientHash,
						emailContentHash: input.emailContentHash,
						sourceIntentId: input.sourceIntentId,
						recoveryId: input.recoveryId,
						kitSubscriberId: input.kitSubscriberId,
						runId: input.audit.runId,
						conversationId: input.audit.conversationId,
						operatorId: input.audit.operatorId,
						approvalReference: input.audit.approvalReference,
						expectedInboundId: input.audit.expectedInboundId,
					},
				}
				return intent
			}),
			claimIntent: vi.fn(async ({ intent: current, claimId }) => {
				writes.push('claim-sending')
				intent = {
					...current,
					status: 'sending',
					metadata: { ...current.metadata, claimId },
				}
				return intent
			}),
			updateIntent: vi.fn(async (current, patch) => {
				writes.push(`update-${patch.status}`)
				intent = {
					...current,
					status: patch.status,
					completedAt: patch.completedAt,
					metadata: patch.metadata,
				}
				return intent
			}),
		},
		email: { build: vi.fn(async () => EMAIL) },
		provider: { findByRecoveryKey, send, read },
		previewSecret: 'preview-secret',
		now: () => FIXED_NOW,
		newClaimId: () => 'claim_1',
	}

	return {
		dependencies,
		findByRecoveryKey,
		read,
		send,
		writes,
		getIntent: () => intent,
		setIntent: (next: RecoveryIntent | null) => {
			intent = next
		},
		setProviderMessage: (next: RecoveryProviderMessage | null) => {
			providerMessage = next
		},
	}
}

async function preview(harness: Harness) {
	const result = await runSupportSkillsLessonOneRecovery({
		command: previewCommand(),
		dependencies: harness.dependencies,
	})
	if (result.state !== 'ready') throw new Error('Expected ready preview')
	return result
}

async function apply(harness: Harness, previewToken: string) {
	return runSupportSkillsLessonOneRecovery({
		command: {
			...previewCommand(),
			operation: 'apply',
			allowWrite: true,
			previewToken,
		},
		dependencies: harness.dependencies,
	})
}

describe('support Skills lesson one recovery', () => {
	let harness: Harness

	beforeEach(() => {
		harness = createHarness()
	})

	it('previews without persisting an intent or sending email', async () => {
		const result = await preview(harness)

		expect(result.intentState).toBe('not-created')
		expect(result.emailContentHash).toMatch(/^[0-9a-f]{64}$/)
		expect(result.message).toEqual(EMAIL)
		expect(result.previewToken).toMatch(/^\d+\.[0-9a-f]{64}$/)
		expect(harness.writes).toEqual([])
		expect(harness.send).not.toHaveBeenCalled()
	})

	it('keeps missing Kit subscribers distinct from missing contacts', async () => {
		vi.mocked(harness.dependencies.subscribers.findByEmail).mockResolvedValueOnce({
			state: 'missing',
		})
		expect(
			await runSupportSkillsLessonOneRecovery({
				command: previewCommand(),
				dependencies: harness.dependencies,
			}),
		).toEqual({ state: 'blocked', reason: 'kit-subscriber-not-found' })

		vi.mocked(harness.dependencies.store.findContext).mockResolvedValueOnce(null)
		expect(
			await runSupportSkillsLessonOneRecovery({
				command: previewCommand(),
				dependencies: harness.dependencies,
			}),
		).toEqual({ state: 'blocked', reason: 'contact-not-found' })
	})

	it('blocks a different Kit subscriber identity before any write', async () => {
		vi.mocked(harness.dependencies.subscribers.findByEmail).mockResolvedValueOnce({
			state: 'found',
			id: 'kit_other',
			email: IDENTITY.email,
			subscriberState: 'active',
		})

		const result = await runSupportSkillsLessonOneRecovery({
			command: previewCommand(),
			dependencies: harness.dependencies,
		})

		expect(result).toEqual({ state: 'blocked', reason: 'identity-mismatch' })
		expect(harness.writes).toEqual([])
	})

	it.each(['1.not-the-preview', '9007199254740991.not-the-preview'])(
		'requires an exact, valid-date, unexpired preview before apply',
		async (previewToken) => {
			const result = await apply(harness, previewToken)

			expect(result).toEqual({
				state: 'blocked',
				reason: 'preview-token-invalid',
			})
			expect(harness.writes).toEqual([])
		},
	)

	it('rebuilds expiring answer links at the preview time during apply', async () => {
		let currentNow = FIXED_NOW
		harness.dependencies.now = () => currentNow
		vi.mocked(harness.dependencies.email.build).mockImplementation(
			async ({ personalizationAt }) => ({
				...EMAIL,
				body: `${EMAIL.body}\nGenerated at ${personalizationAt}`,
			}),
		)
		const prepared = await preview(harness)
		currentNow = new Date(FIXED_NOW.getTime() + 60_000)

		const result = await apply(harness, prepared.previewToken)

		expect(result.state).toBe('pending')
		expect(harness.send).toHaveBeenCalledTimes(1)
	})

	it('persists and claims the intent before sending, then completes after exact provider readback', async () => {
		const prepared = await preview(harness)
		harness.read.mockImplementationOnce(async (messageId) => ({
			messageId,
			status: 'Sent',
			recipient: IDENTITY.email,
			providerRecoveryKey: String(
				harness.getIntent()?.metadata.providerRecoveryKey,
			),
			emailContentHash: prepared.emailContentHash,
		}))

		const result = await apply(harness, prepared.previewToken)

		expect(result).toMatchObject({
			state: 'completed',
			operation: 'apply',
			providerMessageId: 'message_1',
			providerStatus: 'Sent',
			idempotent: false,
		})
		expect(harness.writes.slice(0, 2)).toEqual([
			'create-pending',
			'claim-sending',
		])
		expect(harness.getIntent()?.status).toBe('completed')
		expect(harness.send).toHaveBeenCalledTimes(1)
	})

	it('does not send twice when the provider already has the same recovery key', async () => {
		const prepared = await preview(harness)
		const first = await apply(harness, prepared.previewToken)
		expect(first.state).toBe('pending')
		const recoveryKey = String(
			harness.getIntent()?.metadata.providerRecoveryKey,
		)
		harness.setProviderMessage({
			messageId: 'message_1',
			status: 'Sent',
			recipient: IDENTITY.email,
			providerRecoveryKey: recoveryKey,
			emailContentHash: prepared.emailContentHash,
		})

		const replay = await apply(harness, prepared.previewToken)

		expect(replay).toMatchObject({
			state: 'completed',
			idempotent: true,
			providerMessageId: 'message_1',
		})
		expect(harness.send).toHaveBeenCalledTimes(1)
	})

	it('persists a retryable provider rejection instead of losing it', async () => {
		const prepared = await preview(harness)
		harness.send.mockResolvedValueOnce({
			state: 'rejected',
			reason: 'postmark-429',
			retryable: true,
		})

		const result = await apply(harness, prepared.previewToken)

		expect(result).toMatchObject({
			state: 'failed',
			reason: 'provider-rejected',
			retryable: true,
		})
		expect(harness.getIntent()?.status).toBe('failed')
		expect(harness.getIntent()?.metadata.retryable).toBe(true)
	})

	it('blocks an ambiguous provider result instead of risking a duplicate retry', async () => {
		const prepared = await preview(harness)
		harness.send.mockResolvedValueOnce({
			state: 'ambiguous',
			reason: 'postmark-network-failure',
		})

		const result = await apply(harness, prepared.previewToken)

		expect(result).toMatchObject({
			state: 'blocked',
			reason: 'delivery-state-ambiguous',
		})
		expect(harness.getIntent()?.status).toBe('blocked')
		expect(harness.getIntent()?.metadata).toMatchObject({
			automaticRetryAllowed: false,
			freshApprovalRequired: true,
		})
	})

	it('does not downgrade sending state when provider readback is unavailable', async () => {
		const prepared = await preview(harness)
		await apply(harness, prepared.previewToken)
		harness.findByRecoveryKey.mockRejectedValueOnce(new Error('readback down'))

		const result = await apply(harness, prepared.previewToken)

		expect(result).toMatchObject({
			state: 'blocked',
			reason: 'delivery-state-ambiguous',
		})
		expect(harness.getIntent()?.status).toBe('sending')
		expect(harness.send).toHaveBeenCalledTimes(1)
	})

	it('does not downgrade completed state when provider readback is unavailable', async () => {
		const prepared = await preview(harness)
		await apply(harness, prepared.previewToken)
		const current = harness.getIntent()
		if (!current) throw new Error('Expected intent')
		harness.setIntent({ ...current, status: 'completed' })
		harness.read.mockRejectedValueOnce(new Error('readback down'))

		const result = await apply(harness, prepared.previewToken)

		expect(result).toMatchObject({
			state: 'pending',
			reason: 'provider-readback-pending',
		})
		expect(harness.getIntent()?.status).toBe('completed')
		expect(harness.send).toHaveBeenCalledTimes(1)
	})

	it('never downgrades ambiguous delivery after a provider readback outage', async () => {
		const prepared = await preview(harness)
		harness.send.mockResolvedValueOnce({
			state: 'ambiguous',
			reason: 'postmark-network-failure',
		})
		await apply(harness, prepared.previewToken)

		harness.findByRecoveryKey.mockRejectedValueOnce(new Error('readback down'))
		const duringOutage = await apply(harness, prepared.previewToken)
		expect(duringOutage).toMatchObject({
			state: 'blocked',
			reason: 'recovery-blocked',
		})
		expect(harness.getIntent()?.status).toBe('blocked')

		const afterOutage = await apply(harness, prepared.previewToken)
		expect(afterOutage).toMatchObject({
			state: 'blocked',
			reason: 'recovery-blocked',
		})
		expect(harness.send).toHaveBeenCalledTimes(1)
	})

	it('persists completion when a later readback finds the exact provider message', async () => {
		const prepared = await preview(harness)
		const first = await apply(harness, prepared.previewToken)
		expect(first.state).toBe('pending')
		harness.setProviderMessage({
			messageId: 'message_1',
			status: 'Sent',
			recipient: IDENTITY.email,
			providerRecoveryKey: String(
				harness.getIntent()?.metadata.providerRecoveryKey,
			),
			emailContentHash: prepared.emailContentHash,
		})

		const result = await runSupportSkillsLessonOneRecovery({
			command: { ...previewCommand(), operation: 'readback' },
			dependencies: harness.dependencies,
		})

		expect(result).toMatchObject({
			state: 'completed',
			operation: 'readback',
			providerMessageId: 'message_1',
		})
		expect(harness.getIntent()?.status).toBe('completed')
	})

	it('rejects apply when personalized message content changed after preview', async () => {
		const prepared = await preview(harness)
		vi.mocked(harness.dependencies.email.build).mockResolvedValueOnce({
			...EMAIL,
			body: `${EMAIL.body}\nchanged`,
		})

		const result = await apply(harness, prepared.previewToken)

		expect(result).toEqual({
			state: 'blocked',
			reason: 'preview-token-invalid',
		})
		expect(harness.send).not.toHaveBeenCalled()
	})

	it('blocks provider readback when the content hash does not match the preview', async () => {
		const prepared = await preview(harness)
		await apply(harness, prepared.previewToken)
		harness.setProviderMessage({
			messageId: 'message_1',
			status: 'Sent',
			recipient: IDENTITY.email,
			providerRecoveryKey: String(
				harness.getIntent()?.metadata.providerRecoveryKey,
			),
			emailContentHash: 'different-content',
		})

		const result = await runSupportSkillsLessonOneRecovery({
			command: { ...previewCommand(), operation: 'readback' },
			dependencies: harness.dependencies,
		})

		expect(result).toMatchObject({
			state: 'blocked',
			reason: 'provider-readback-mismatch',
		})
		expect(harness.getIntent()?.status).toBe('sending')
	})

	it('rejects reuse of a recovery id under different operator authority', async () => {
		const prepared = await preview(harness)
		await apply(harness, prepared.previewToken)
		const changedCommand: SkillsLessonOneRecoveryCommand = {
			...previewCommand(),
			operation: 'preview',
			audit: { ...AUDIT, approvalReference: 'different-approval' },
		}
		const changedPreview = await runSupportSkillsLessonOneRecovery({
			command: changedCommand,
			dependencies: harness.dependencies,
		})
		if (changedPreview.state !== 'ready') throw new Error('Expected preview')

		const result = await runSupportSkillsLessonOneRecovery({
			command: {
				...changedCommand,
				operation: 'apply',
				allowWrite: true,
				previewToken: changedPreview.previewToken,
			},
			dependencies: harness.dependencies,
		})

		expect(result).toMatchObject({
			state: 'blocked',
			reason: 'intent-idempotency-conflict',
		})
		expect(harness.send).toHaveBeenCalledTimes(1)
	})

	it('rejects reuse of a recovery id for a different recipient identity', async () => {
		const prepared = await preview(harness)
		await apply(harness, prepared.previewToken)
		vi.mocked(harness.dependencies.subscribers.findByEmail).mockResolvedValue({
			state: 'found',
			id: 'kit_42',
			email: 'other@example.com',
			subscriberState: 'active',
		})
		vi.mocked(harness.dependencies.store.findContext).mockResolvedValue({
			contactId: 'contact_41',
			sourceIntentId: 'source_intent_1',
			sourceNextActionId: 'source_action_1',
		})
		const otherCommand: SkillsLessonOneRecoveryCommand = {
			...previewCommand(),
			operation: 'preview',
			identity: {
				email: 'other@example.com',
				kitSubscriberId: 'kit_42',
			},
		}
		const otherPreview = await runSupportSkillsLessonOneRecovery({
			command: otherCommand,
			dependencies: harness.dependencies,
		})
		if (otherPreview.state !== 'ready') throw new Error('Expected preview')

		const result = await runSupportSkillsLessonOneRecovery({
			command: {
				...otherCommand,
				operation: 'apply',
				allowWrite: true,
				previewToken: otherPreview.previewToken,
			},
			dependencies: harness.dependencies,
		})

		expect(result).toMatchObject({
			state: 'blocked',
			reason: 'intent-idempotency-conflict',
		})
		expect(harness.send).toHaveBeenCalledTimes(1)
	})
})
