import { randomUUID } from 'node:crypto'

import { and, eq, inArray } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { sideEffectIntent } from '@/db/schema'
import { env } from '@/env.mjs'
import { buildSkillsCourseLessonOneEmail } from '@/lib/skills-course/lesson-one-email'
import { createPostmarkSkillsLessonOneRecoveryProvider } from '@/lib/skills-course/postmark-lesson-one-recovery'
import {
	runSupportSkillsLessonOneRecovery,
	type RecoveryIntent,
	type RecoveryIntentPatch,
	type SkillsLessonOneRecoveryCommand,
	type SkillsLessonOneRecoveryDependencies,
} from '@/lib/skills-course/support-lesson-one-recovery'
import { isMysqlDuplicateEntryError } from '@/lib/mysql-primary-key-retry'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	SKILLS_WORKFLOW_EMAIL_ZERO,
	SKILLS_WORKFLOW_VALUE_PATH,
} from '@/lib/subscriber-marketing/skills-newsletter-path-entry'
import type { SideEffectIntent } from '@/lib/subscriber-marketing/types'
import { getValuePathAnswerPages } from '@/lib/subscriber-marketing/value-path-answer-page'
import { buildValuePathEmailPersonalization } from '@/lib/subscriber-marketing/value-path-email-executor'
import { verifySupportSignature } from '@/lib/support-signature'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

const identitySchema = z
	.object({
		email: z.string().email(),
		kitSubscriberId: z.string().min(1).max(64),
	})
	.strict()

const auditSchema = z
	.object({
		runId: z.string().min(1).max(128),
		conversationId: z.string().min(1).max(128),
		operatorId: z.string().min(1).max(128),
		approvalReference: z.string().min(1).max(256),
		expectedInboundId: z.string().min(1).max(128),
	})
	.strict()

const baseRequest = {
	identity: identitySchema,
	recoveryId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
	audit: auditSchema,
}

const requestSchema = z.discriminatedUnion('operation', [
	z.object({ ...baseRequest, operation: z.literal('preview') }).strict(),
	z
		.object({
			...baseRequest,
			operation: z.literal('apply'),
			allowWrite: z.literal(true),
			previewToken: z.string().min(1).max(256),
		})
		.strict(),
	z.object({ ...baseRequest, operation: z.literal('readback') }).strict(),
])

export function createSkillsLessonOneRecoveryPostHandler(args: {
	webhookSecret?: string
	dependencies?: SkillsLessonOneRecoveryDependencies
}) {
	return async (request: NextRequest) => {
		if (!args.webhookSecret) {
			return NextResponse.json(
				{ error: 'Support integration not configured' },
				{ status: 503 },
			)
		}

		const bodyText = await request.text()
		const signature = verifySupportSignature({
			signatureHeader: request.headers.get('x-support-signature'),
			bodyText,
			webhookSecret: args.webhookSecret,
		})
		if (!signature.valid) {
			return NextResponse.json({ error: signature.error }, { status: 401 })
		}

		let body: unknown
		try {
			body = JSON.parse(bodyText)
		} catch {
			return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
		}
		const parsed = requestSchema.safeParse(body)
		if (!parsed.success) {
			return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
		}

		const command: SkillsLessonOneRecoveryCommand = parsed.data
		const dependencies =
			args.dependencies ?? createProductionDependencies(args.webhookSecret)
		const result = await runSupportSkillsLessonOneRecovery({
			command,
			dependencies,
		})
		await log.info('skills.course.lesson_one_support_recovery', {
			operation: command.operation,
			state: result.state,
			recoveryId: command.recoveryId,
			runId: command.audit.runId,
			conversationId: command.audit.conversationId,
			operatorId: command.audit.operatorId,
			...(result.state === 'completed' ||
			result.state === 'pending' ||
			result.state === 'failed' ||
			(result.state === 'blocked' && result.intentId)
				? { intentId: result.intentId }
				: {}),
		})

		return NextResponse.json(result, { status: resultStatus(result) })
	}
}

const productionHandler = createSkillsLessonOneRecoveryPostHandler({
	webhookSecret: env.SUPPORT_WEBHOOK_SECRET,
})

export const POST = withSkill(productionHandler)

function createProductionDependencies(
	previewSecret: string,
): SkillsLessonOneRecoveryDependencies {
	const repository = new DrizzleCaptureMarketingRepository(db)
	const provider = createPostmarkSkillsLessonOneRecoveryProvider({
		apiKey: env.POSTMARK_API_KEY,
		from: `${env.NEXT_PUBLIC_SITE_TITLE} <${env.NEXT_PUBLIC_SUPPORT_EMAIL}>`,
		replyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
	})

	const findIntent = async (idempotencyKey: string) => {
		const intent =
			await repository.findSideEffectIntentByIdempotencyKey(idempotencyKey)
		return intent ? toRecoveryIntent(intent) : null
	}

	return {
		subscribers: {
			async findByEmail(email) {
				let raw: unknown
				try {
					raw = await emailListProvider.getSubscriberByEmail(email)
				} catch {
					return { state: 'invalid' }
				}
				if (!raw) return { state: 'missing' }
				const subscriber = SubscriberSchema.safeParse(raw)
				if (!subscriber.success || !subscriber.data.email_address) {
					return { state: 'invalid' }
				}
				return {
					state: 'found',
					id: String(subscriber.data.id),
					email: subscriber.data.email_address,
					subscriberState: subscriber.data.state,
				}
			},
		},
		store: {
			async findContext(email) {
				const contact = await repository.findContactByEmail(email)
				if (!contact) return null
				const intents =
					await repository.findValuePathEmailSideEffectIntentsByContact(
						contact.id,
					)
				const sourceIntent = intents.find(
					(intent) =>
						intent.metadata.valuePathSlug === SKILLS_WORKFLOW_VALUE_PATH &&
						intent.metadata.emailResourceId === SKILLS_WORKFLOW_EMAIL_ZERO,
				)
				return {
					contactId: contact.id,
					sourceIntentId: sourceIntent?.id,
					sourceNextActionId: sourceIntent?.nextActionId,
					sourceKitSubscriberId: metadataString(
						sourceIntent,
						'kitSubscriberId',
					),
				}
			},
			findIntent,
			async createIntent(input) {
				const record: SideEffectIntent = {
					id: repository.newId('side_effect_intent'),
					nextActionId: input.nextActionId,
					contactId: input.contactId,
					provider: 'postmark',
					type: 'send-skills-course-lesson-one-recovery',
					status: 'pending',
					completedAt: null,
					idempotencyKey: input.idempotencyKey,
					gates: [
						{
							slug: 'customer-visible-side-effects',
							passed: true,
							reason: 'signed support recovery with explicit allow-write',
						},
					],
					reviewReasons: [],
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
					createdAt: input.createdAt,
				}
				try {
					return toRecoveryIntent(
						await repository.createSideEffectIntent(record),
					)
				} catch (error) {
					if (!isMysqlDuplicateEntryError(error)) throw error
					const existing = await findIntent(input.idempotencyKey)
					if (!existing) throw error
					return existing
				}
			},
			async claimIntent({ intent, claimId, claimedAt }) {
				await db
					.update(sideEffectIntent)
					.set({
						status: 'sending',
						reviewReasons: ['provider-delivery-state-unconfirmed'],
						metadata: {
							...intent.metadata,
							claimId,
							claimedAt,
							automaticRetryAllowed: false,
						},
					})
					.where(
						and(
							eq(sideEffectIntent.id, intent.id),
							inArray(sideEffectIntent.status, ['pending', 'failed']),
						),
					)
				const claimed = await findIntentById(intent.id)
				if (!claimed) throw new Error(`Missing recovery intent ${intent.id}`)
				return claimed
			},
			async updateIntent(intent, patch) {
				return toRecoveryIntent(
					await repository.updateSideEffectIntent(intent.id, {
						status: patch.status,
						completedAt: patch.completedAt ?? null,
						gates: [
							{
								slug: 'customer-visible-side-effects',
								passed: patch.status !== 'blocked',
								reason: 'signed support recovery lifecycle',
							},
						],
						reviewReasons: patch.reviewReasons,
						metadata: patch.metadata,
					}),
				)
			},
		},
		email: {
			async build({ contactId, kitSubscriberId, personalizationAt }) {
				const pathTokenSecret = process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET
				if (!pathTokenSecret) {
					throw new Error('AI_HERO_VALUE_PATH_TOKEN_SECRET is not configured')
				}
				const personalization = buildValuePathEmailPersonalization({
					contactId,
					kitSubscriberId,
					valuePathSlug: SKILLS_WORKFLOW_VALUE_PATH,
					emailResourceId: SKILLS_WORKFLOW_EMAIL_ZERO,
					answerPages: await getValuePathAnswerPages(),
					baseUrl: env.NEXT_PUBLIC_URL,
					pathTokenSecret,
					now: personalizationAt,
				})
				if (!personalization.passed) {
					throw new Error(personalization.reviewReasons.join(', '))
				}
				return buildSkillsCourseLessonOneEmail(
					personalization.fields as Record<string, string>,
				)
			},
		},
		provider,
		previewSecret,
		now: () => new Date(),
		newClaimId: randomUUID,
	}
}

async function findIntentById(intentId: string) {
	const rows = await db
		.select()
		.from(sideEffectIntent)
		.where(eq(sideEffectIntent.id, intentId))
		.limit(1)
	return rows[0] ? toRecoveryIntent(rows[0]) : null
}

const recoveryIntentStatusSchema = z.enum([
	'dry-run',
	'gated',
	'blocked',
	'pending',
	'sending',
	'completed',
	'failed',
	'skipped',
])

function toRecoveryIntent(intent: {
	id: string
	contactId: string
	status: string
	completedAt?: string | Date | null
	metadata: Record<string, unknown>
}): RecoveryIntent {
	return {
		id: intent.id,
		contactId: intent.contactId,
		status: recoveryIntentStatusSchema.parse(intent.status),
		completedAt:
			intent.completedAt instanceof Date
				? intent.completedAt.toISOString()
				: intent.completedAt,
		metadata: intent.metadata,
	}
}

function metadataString(intent: SideEffectIntent | undefined, key: string) {
	const value = intent?.metadata[key]
	return typeof value === 'string' ? value : undefined
}

function resultStatus(
	result: Awaited<ReturnType<typeof runSupportSkillsLessonOneRecovery>>,
) {
	switch (result.state) {
		case 'ready':
		case 'completed':
		case 'pending':
			return 200
		case 'confirmation-required':
		case 'blocked':
			return 409
		case 'failed':
			return 502
	}
}
