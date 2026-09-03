import {
	createHash,
	createHmac,
	timingSafeEqual,
} from 'node:crypto'

import type { SideEffectIntentStatus } from '@/lib/subscriber-marketing/types'

import type { buildSkillsCourseLessonOneEmail } from './lesson-one-email'

const PREVIEW_TTL_MS = 5 * 60 * 1000

export type SkillsLessonOneRecoveryAudit = {
	runId: string
	conversationId: string
	operatorId: string
	approvalReference: string
	expectedInboundId: string
}

export type SkillsLessonOneRecoveryIdentity = {
	email: string
	kitSubscriberId: string
}

type RecoveryRequestBase = {
	identity: SkillsLessonOneRecoveryIdentity
	recoveryId: string
	audit: SkillsLessonOneRecoveryAudit
}

export type SkillsLessonOneRecoveryCommand =
	| (RecoveryRequestBase & { operation: 'preview' })
	| (RecoveryRequestBase & {
			operation: 'apply'
			allowWrite: true
			previewToken: string
	  })
	| (RecoveryRequestBase & { operation: 'readback' })

export type RecoverySubscriberLookup =
	| { state: 'found'; id: string; email: string; subscriberState?: string }
	| { state: 'missing' }
	| { state: 'invalid' }

export type RecoveryContext = {
	contactId: string
	sourceIntentId?: string
	sourceNextActionId?: string
	sourceKitSubscriberId?: string
}

export type RecoveryIntent = {
	id: string
	contactId: string
	status: SideEffectIntentStatus
	completedAt?: string | null
	metadata: Record<string, unknown>
}

export type RecoveryIntentInput = {
	contactId: string
	nextActionId: string
	idempotencyKey: string
	providerRecoveryKey: string
	recoveryId: string
	kitSubscriberId: string
	audit: SkillsLessonOneRecoveryAudit
	createdAt: string
}

export type RecoveryIntentPatch = {
	status: SideEffectIntentStatus
	completedAt?: string | null
	reviewReasons: string[]
	metadata: Record<string, unknown>
}

export type RecoveryProviderMessage = {
	messageId: string
	status: string
	recipient: string
	providerRecoveryKey: string
}

export type RecoveryProviderSendResult =
	| { state: 'accepted'; messageId: string }
	| { state: 'rejected'; reason: string; retryable: boolean }
	| { state: 'ambiguous'; reason: string }

export type SkillsLessonOneRecoveryDependencies = {
	subscribers: {
		findByEmail(email: string): Promise<RecoverySubscriberLookup>
	}
	store: {
		findContext(email: string): Promise<RecoveryContext | null>
		findIntent(idempotencyKey: string): Promise<RecoveryIntent | null>
		createIntent(input: RecoveryIntentInput): Promise<RecoveryIntent>
		claimIntent(args: {
			intent: RecoveryIntent
			claimId: string
			claimedAt: string
		}): Promise<RecoveryIntent>
		updateIntent(
			intent: RecoveryIntent,
			patch: RecoveryIntentPatch,
		): Promise<RecoveryIntent>
	}
	email: {
		build(args: {
			contactId: string
			kitSubscriberId: string
		}): Promise<ReturnType<typeof buildSkillsCourseLessonOneEmail>>
	}
	provider: {
		findByRecoveryKey(args: {
			recipient: string
			providerRecoveryKey: string
		}): Promise<RecoveryProviderMessage | null>
		send(args: {
			recipient: string
			providerRecoveryKey: string
			email: ReturnType<typeof buildSkillsCourseLessonOneEmail>
		}): Promise<RecoveryProviderSendResult>
		read(messageId: string): Promise<RecoveryProviderMessage | null>
	}
	previewSecret: string
	now(): Date
	newClaimId(): string
}

export type SkillsLessonOneRecoveryResult =
	| {
			state: 'ready'
			operation: 'preview'
			previewToken: string
			previewExpiresAt: string
			intentState: SideEffectIntentStatus | 'not-created'
		  }
	| {
			state: 'completed'
			operation: 'apply' | 'readback'
			intentId: string
			providerMessageId: string
			providerStatus: string
			idempotent: boolean
		  }
	| {
			state: 'pending'
			operation: 'apply' | 'readback'
			intentId: string
			reason: 'delivery-in-progress' | 'provider-readback-pending'
		  }
	| {
			state: 'failed'
			operation: 'apply'
			intentId: string
			reason: 'provider-preflight-failed' | 'provider-rejected'
			retryable: boolean
		  }
	| {
			state: 'confirmation-required'
			reason: 'kit-subscriber-not-active'
		  }
	| {
			state: 'blocked'
			reason:
				| 'kit-subscriber-not-found'
				| 'kit-subscriber-invalid'
				| 'identity-mismatch'
				| 'contact-not-found'
				| 'course-enrollment-not-found'
				| 'course-enrollment-identity-mismatch'
				| 'personalization-failed'
				| 'preview-token-invalid'
				| 'intent-idempotency-conflict'
				| 'delivery-state-ambiguous'
				| 'provider-readback-missing'
				| 'provider-readback-mismatch'
				| 'recovery-blocked'
			intentId?: string
		  }

export async function runSupportSkillsLessonOneRecovery(args: {
	command: SkillsLessonOneRecoveryCommand
	dependencies: SkillsLessonOneRecoveryDependencies
}): Promise<SkillsLessonOneRecoveryResult> {
	const prepared = await prepareRecovery(args.command, args.dependencies)
	if ('state' in prepared) return prepared

	if (args.command.operation === 'preview') {
		const existing = await args.dependencies.store.findIntent(
			prepared.idempotencyKey,
		)
		const preview = createPreviewToken({
			command: args.command,
			prepared,
			secret: args.dependencies.previewSecret,
			now: args.dependencies.now(),
		})
		return {
			state: 'ready',
			operation: 'preview',
			previewToken: preview.token,
			previewExpiresAt: preview.expiresAt,
			intentState: existing?.status ?? 'not-created',
		}
	}

	if (args.command.operation === 'readback') {
		return readbackRecovery({ prepared, dependencies: args.dependencies })
	}

	if (
		!verifyPreviewToken({
			command: args.command,
			prepared,
			secret: args.dependencies.previewSecret,
			now: args.dependencies.now(),
			token: args.command.previewToken,
		})
	) {
		return { state: 'blocked', reason: 'preview-token-invalid' }
	}

	return applyRecovery({ prepared, dependencies: args.dependencies })
}

type PreparedRecovery = {
	email: string
	kitSubscriberId: string
	contactId: string
	sourceIntentId: string
	sourceNextActionId: string
	idempotencyKey: string
	providerRecoveryKey: string
	recoveryId: string
	audit: SkillsLessonOneRecoveryAudit
	emailContent: ReturnType<typeof buildSkillsCourseLessonOneEmail>
}

async function prepareRecovery(
	command: SkillsLessonOneRecoveryCommand,
	dependencies: SkillsLessonOneRecoveryDependencies,
): Promise<PreparedRecovery | SkillsLessonOneRecoveryResult> {
	const email = normalizeEmail(command.identity.email)
	const subscriber = await dependencies.subscribers.findByEmail(email)
	if (subscriber.state === 'missing') {
		return { state: 'blocked', reason: 'kit-subscriber-not-found' }
	}
	if (subscriber.state === 'invalid') {
		return { state: 'blocked', reason: 'kit-subscriber-invalid' }
	}
	if (
		normalizeEmail(subscriber.email) !== email ||
		subscriber.id !== command.identity.kitSubscriberId
	) {
		return { state: 'blocked', reason: 'identity-mismatch' }
	}
	if (subscriber.subscriberState !== 'active') {
		return {
			state: 'confirmation-required',
			reason: 'kit-subscriber-not-active',
		}
	}

	const context = await dependencies.store.findContext(email)
	if (!context) {
		return { state: 'blocked', reason: 'contact-not-found' }
	}
	if (!context.sourceIntentId || !context.sourceNextActionId) {
		return { state: 'blocked', reason: 'course-enrollment-not-found' }
	}
	if (
		context.sourceKitSubscriberId &&
		context.sourceKitSubscriberId !== command.identity.kitSubscriberId
	) {
		return {
			state: 'blocked',
			reason: 'course-enrollment-identity-mismatch',
		}
	}

	let emailContent: ReturnType<typeof buildSkillsCourseLessonOneEmail>
	try {
		emailContent = await dependencies.email.build({
			contactId: context.contactId,
			kitSubscriberId: command.identity.kitSubscriberId,
		})
	} catch {
		return { state: 'blocked', reason: 'personalization-failed' }
	}

	const idempotencyKey = [
		'support',
		'skills-course-lesson-one',
		context.contactId,
		command.recoveryId,
	].join(':')

	return {
		email,
		kitSubscriberId: command.identity.kitSubscriberId,
		contactId: context.contactId,
		sourceIntentId: context.sourceIntentId,
		sourceNextActionId: context.sourceNextActionId,
		idempotencyKey,
		providerRecoveryKey: createHash('sha256')
			.update(idempotencyKey)
			.digest('hex'),
		recoveryId: command.recoveryId,
		audit: command.audit,
		emailContent,
	}
}

async function applyRecovery(args: {
	prepared: PreparedRecovery
	dependencies: SkillsLessonOneRecoveryDependencies
}): Promise<SkillsLessonOneRecoveryResult> {
	const { prepared, dependencies } = args
	let intent = await dependencies.store.findIntent(prepared.idempotencyKey)
	if (!intent) {
		intent = await dependencies.store.createIntent({
			contactId: prepared.contactId,
			nextActionId: prepared.sourceNextActionId,
			idempotencyKey: prepared.idempotencyKey,
			providerRecoveryKey: prepared.providerRecoveryKey,
			recoveryId: prepared.recoveryId,
			kitSubscriberId: prepared.kitSubscriberId,
			audit: prepared.audit,
			createdAt: dependencies.now().toISOString(),
		})
	}

	if (metadataString(intent, 'providerRecoveryKey') !== prepared.providerRecoveryKey) {
		return {
			state: 'blocked',
			reason: 'intent-idempotency-conflict',
			intentId: intent.id,
		}
	}

	const providerPreflight = await findProviderMessage({
		intent,
		prepared,
		dependencies,
	})
	if (providerPreflight.state === 'failed') {
		intent = await dependencies.store.updateIntent(intent, {
			status: 'failed',
			completedAt: null,
			reviewReasons: ['provider-readback-failed-before-send'],
			metadata: {
				...intent.metadata,
				failedAt: dependencies.now().toISOString(),
				retryable: true,
			},
		})
		return {
			state: 'failed',
			operation: 'apply',
			intentId: intent.id,
			reason: 'provider-preflight-failed',
			retryable: true,
		}
	}
	if (providerPreflight.message) {
		return completeFromProvider({
			intent,
			message: providerPreflight.message,
			prepared,
			dependencies,
			idempotent: true,
		})
	}

	if (intent.status === 'completed') {
		return {
			state: 'blocked',
			reason: 'provider-readback-missing',
			intentId: intent.id,
		}
	}
	if (intent.status === 'sending') {
		return {
			state: 'blocked',
			reason: 'delivery-state-ambiguous',
			intentId: intent.id,
		}
	}
	if (
		intent.status === 'blocked' ||
		(intent.status === 'failed' && intent.metadata.retryable === false)
	) {
		return {
			state: 'blocked',
			reason: 'recovery-blocked',
			intentId: intent.id,
		}
	}

	const claimId = dependencies.newClaimId()
	intent = await dependencies.store.claimIntent({
		intent,
		claimId,
		claimedAt: dependencies.now().toISOString(),
	})
	if (
		intent.status !== 'sending' ||
		metadataString(intent, 'claimId') !== claimId
	) {
		return {
			state: 'pending',
			operation: 'apply',
			intentId: intent.id,
			reason: 'delivery-in-progress',
		}
	}

	let sendResult: RecoveryProviderSendResult
	try {
		sendResult = await dependencies.provider.send({
			recipient: prepared.email,
			providerRecoveryKey: prepared.providerRecoveryKey,
			email: prepared.emailContent,
		})
	} catch {
		sendResult = { state: 'ambiguous', reason: 'provider-request-threw' }
	}

	if (sendResult.state === 'rejected') {
		intent = await dependencies.store.updateIntent(intent, {
			status: 'failed',
			completedAt: null,
			reviewReasons: ['provider-rejected'],
			metadata: {
				...intent.metadata,
				failedAt: dependencies.now().toISOString(),
				retryable: sendResult.retryable,
				providerFailureReason: sendResult.reason,
			},
		})
		return {
			state: 'failed',
			operation: 'apply',
			intentId: intent.id,
			reason: 'provider-rejected',
			retryable: sendResult.retryable,
		}
	}
	if (sendResult.state === 'ambiguous') {
		intent = await dependencies.store.updateIntent(intent, {
			status: 'blocked',
			completedAt: null,
			reviewReasons: ['provider-delivery-ambiguous'],
			metadata: {
				...intent.metadata,
				blockedAt: dependencies.now().toISOString(),
				deliveryAmbiguous: true,
				providerFailureReason: sendResult.reason,
			},
		})
		return {
			state: 'blocked',
			reason: 'delivery-state-ambiguous',
			intentId: intent.id,
		}
	}

	intent = await dependencies.store.updateIntent(intent, {
		status: 'sending',
		completedAt: null,
		reviewReasons: ['provider-readback-pending'],
		metadata: {
			...intent.metadata,
			providerMessageId: sendResult.messageId,
			providerAcceptedAt: dependencies.now().toISOString(),
		},
	})

	let message: RecoveryProviderMessage | null = null
	try {
		message = await dependencies.provider.read(sendResult.messageId)
	} catch {
		// The provider accepted the message. A later readback can finish the intent.
	}
	if (!message) {
		return {
			state: 'pending',
			operation: 'apply',
			intentId: intent.id,
			reason: 'provider-readback-pending',
		}
	}

	return completeFromProvider({
		intent,
		message,
		prepared,
		dependencies,
		idempotent: false,
	})
}

async function readbackRecovery(args: {
	prepared: PreparedRecovery
	dependencies: SkillsLessonOneRecoveryDependencies
}): Promise<SkillsLessonOneRecoveryResult> {
	const intent = await args.dependencies.store.findIntent(
		args.prepared.idempotencyKey,
	)
	if (!intent) {
		return { state: 'blocked', reason: 'provider-readback-missing' }
	}
	const provider = await findProviderMessage({
		intent,
		prepared: args.prepared,
		dependencies: args.dependencies,
	})
	if (provider.state === 'failed' || !provider.message) {
		return {
			state: 'pending',
			operation: 'readback',
			intentId: intent.id,
			reason: 'provider-readback-pending',
		}
	}
	if (!providerMessageMatches(provider.message, args.prepared)) {
		return {
			state: 'blocked',
			reason: 'provider-readback-mismatch',
			intentId: intent.id,
		}
	}
	return {
		state: 'completed',
		operation: 'readback',
		intentId: intent.id,
		providerMessageId: provider.message.messageId,
		providerStatus: provider.message.status,
		idempotent: true,
	}
}

async function findProviderMessage(args: {
	intent: RecoveryIntent
	prepared: PreparedRecovery
	dependencies: SkillsLessonOneRecoveryDependencies
}): Promise<
	| { state: 'found'; message: RecoveryProviderMessage | null }
	| { state: 'failed'; message: null }
> {
	try {
		const messageId = metadataString(args.intent, 'providerMessageId')
		const message = messageId
			? await args.dependencies.provider.read(messageId)
			: await args.dependencies.provider.findByRecoveryKey({
					recipient: args.prepared.email,
					providerRecoveryKey: args.prepared.providerRecoveryKey,
				})
		return { state: 'found', message }
	} catch {
		return { state: 'failed', message: null }
	}
}

async function completeFromProvider(args: {
	intent: RecoveryIntent
	message: RecoveryProviderMessage
	prepared: PreparedRecovery
	dependencies: SkillsLessonOneRecoveryDependencies
	idempotent: boolean
}): Promise<SkillsLessonOneRecoveryResult> {
	if (!providerMessageMatches(args.message, args.prepared)) {
		const blocked = await args.dependencies.store.updateIntent(args.intent, {
			status: 'blocked',
			completedAt: null,
			reviewReasons: ['provider-readback-mismatch'],
			metadata: {
				...args.intent.metadata,
				blockedAt: args.dependencies.now().toISOString(),
			},
		})
		return {
			state: 'blocked',
			reason: 'provider-readback-mismatch',
			intentId: blocked.id,
		}
	}

	const completedAt = args.dependencies.now().toISOString()
	const completed = await args.dependencies.store.updateIntent(args.intent, {
		status: 'completed',
		completedAt,
		reviewReasons: [],
		metadata: {
			...args.intent.metadata,
			providerMessageId: args.message.messageId,
			providerStatus: args.message.status,
			providerReadbackAt: completedAt,
		},
	})
	return {
		state: 'completed',
		operation: 'apply',
		intentId: completed.id,
		providerMessageId: args.message.messageId,
		providerStatus: args.message.status,
		idempotent: args.idempotent,
	}
}

function providerMessageMatches(
	message: RecoveryProviderMessage,
	prepared: PreparedRecovery,
) {
	return (
		normalizeEmail(message.recipient) === prepared.email &&
		message.providerRecoveryKey === prepared.providerRecoveryKey
	)
}

function metadataString(intent: RecoveryIntent, key: string) {
	const value = intent.metadata[key]
	return typeof value === 'string' ? value : undefined
}

function createPreviewToken(args: {
	command: RecoveryRequestBase
	prepared: PreparedRecovery
	secret: string
	now: Date
}) {
	const expiresAtMs = args.now.getTime() + PREVIEW_TTL_MS
	const signature = signPreviewBinding({ ...args, expiresAtMs })
	return {
		token: `${expiresAtMs}.${signature}`,
		expiresAt: new Date(expiresAtMs).toISOString(),
	}
}

function verifyPreviewToken(args: {
	command: RecoveryRequestBase
	prepared: PreparedRecovery
	secret: string
	now: Date
	token: string
}) {
	const [expiresAtValue, receivedSignature, extra] = args.token.split('.')
	if (!expiresAtValue || !receivedSignature || extra) return false
	const expiresAtMs = Number(expiresAtValue)
	if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < args.now.getTime()) {
		return false
	}
	if (expiresAtMs > args.now.getTime() + PREVIEW_TTL_MS) return false
	const expectedSignature = signPreviewBinding({ ...args, expiresAtMs })
	const received = Buffer.from(receivedSignature)
	const expected = Buffer.from(expectedSignature)
	return received.length === expected.length && timingSafeEqual(received, expected)
}

function signPreviewBinding(args: {
	command: RecoveryRequestBase
	prepared: PreparedRecovery
	secret: string
	expiresAtMs: number
}) {
	const binding = JSON.stringify({
		expiresAtMs: args.expiresAtMs,
		email: args.prepared.email,
		kitSubscriberId: args.prepared.kitSubscriberId,
		contactId: args.prepared.contactId,
		sourceIntentId: args.prepared.sourceIntentId,
		recoveryId: args.command.recoveryId,
		audit: args.command.audit,
	})
	return createHmac('sha256', args.secret).update(binding).digest('hex')
}

function normalizeEmail(email: string) {
	return email.trim().toLowerCase()
}
