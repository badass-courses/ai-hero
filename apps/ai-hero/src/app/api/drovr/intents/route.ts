import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/db'
import { providerIdentity } from '@/db/schema'
import { env } from '@/env.mjs'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	acceptDrovrIntent,
	DrovrIntentSchema,
} from '@/lib/subscriber-marketing/drovr-executor'
import { parseDrovrEvergreenConfig } from '@/lib/subscriber-marketing/drovr-evergreen'
import {
	createKitFormSubscriber,
	linkKitSubscriberIdentity,
} from '@/lib/subscriber-marketing/drovr-list-subscribe'
import { createKitUnsubscriber } from '@/lib/subscriber-marketing/drovr-list-unsubscribe'
import {
	drovrSendBudget,
	parseDrovrSyncSendConfig,
} from '@/lib/subscriber-marketing/drovr-sync-send'
import { createEmailCourseShadowRuntime } from '@/lib/subscriber-marketing/email-course-shadow-runtime'
import { getValuePathAnswerPages } from '@/lib/subscriber-marketing/value-path-answer-page'
import { executeValuePathEmailIntent } from '@/lib/subscriber-marketing/value-path-email-executor'
import { buildValuePathExecutorConfig } from '@/lib/subscriber-marketing/value-path-executor-config'
import { readActiveGateDRuntimeAllowlist } from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'
import { withSkill } from '@/server/with-skill'
import { and, eq } from 'drizzle-orm'

/**
 * drovr's executor endpoint: the SendPort adapter for tenant org-aihero.
 *
 * drovr's ContactActor posts an intent here inside its outbox guard. The
 * answer steers drovr: 202 accepted means the sender cron owns delivery
 * and the completion arrives later through POST /events; 200 completed
 * carries the completion inline for an intent ai-hero already finished;
 * 200 blocked means ai-hero's gates refused and a human must look;
 * 200 retry names a wait (Kit rate limit or drovr's send budget); 200
 * failed names a terminal reason class and must never be mistaken for 202.
 * list.unsubscribe applies inside the request and answers 200 completed,
 * retry, or blocked; it never answers 202 or failed. With
 * AIH_DROVR_SYNC_SEND the skills-course send runs inside this request
 * (decision 2026-09-17) and 202 stops appearing for it.
 * Refusals are RFC 9457 problem details with a hint, the same shape drovr
 * speaks, so an agent debugging either side reads one vocabulary.
 */

const problem = (
	status: number,
	slug: string,
	title: string,
	detail: string,
	hint: string,
) =>
	NextResponse.json(
		{ type: `urn:aihero:problem:${slug}`, title, status, detail, hint },
		{ status, headers: { 'content-type': 'application/problem+json' } },
	)

const bearerMatches = (header: string | null, secret: string): boolean => {
	const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
	if (!token) return false
	const a = Buffer.from(token)
	const b = Buffer.from(secret)
	return a.length === b.length && timingSafeEqual(a, b)
}

const findKitSubscriberId = async (
	contactId: string,
): Promise<string | undefined> => {
	const rows = await db
		.select({ externalId: providerIdentity.externalId })
		.from(providerIdentity)
		.where(
			and(
				eq(providerIdentity.contactId, contactId),
				eq(providerIdentity.provider, 'kit'),
			),
		)
		.limit(1)
	return rows[0]?.externalId
}

export const POST = withSkill(async (request: NextRequest) => {
	const secret = env.DROVR_EXECUTOR_TOKEN
	if (!secret) {
		return problem(
			503,
			'executor-not-configured',
			'drovr executor is not configured',
			'DROVR_EXECUTOR_TOKEN is not set on this deployment.',
			'Set the token in the environment and redeploy; drovr keeps the intent retryable.',
		)
	}
	if (!bearerMatches(request.headers.get('authorization'), secret)) {
		return problem(
			401,
			'unauthorized',
			'Bearer token missing or wrong',
			'This endpoint is for drovr only.',
			'Send Authorization: Bearer <DROVR_EXECUTOR_TOKEN>.',
		)
	}

	let body: unknown
	try {
		body = await request.json()
	} catch {
		return problem(
			400,
			'malformed-intent',
			'Body is not JSON',
			'The request body could not be parsed.',
			'POST a drovr Intent as JSON.',
		)
	}
	const parsed = DrovrIntentSchema.safeParse(body)
	if (!parsed.success) {
		return problem(
			400,
			'malformed-intent',
			'Intent does not match the drovr Intent shape',
			parsed.error.issues.map((issue) => issue.message).join('; '),
			'Send { tenantId, contactId, journeyId, kind, idempotencyKey, dueAt, payload }.',
		)
	}

	const repository = new DrizzleCaptureMarketingRepository(db)
	const syncSend = parseDrovrSyncSendConfig(process.env)
	let sync: Pick<
		Parameters<typeof acceptDrovrIntent>[0],
		'sendNow' | 'budget'
	> = {}
	if (syncSend.enabled && parsed.data.kind === 'email.send') {
		const allowlist = await readActiveGateDRuntimeAllowlist({ redis })
		if (allowlist.passed && allowlist.allowlist) {
			const config = buildValuePathExecutorConfig({
				runtimeAllowlist: allowlist.allowlist,
				answerPages: await getValuePathAnswerPages(),
				env: process.env,
			})
			const shadowObserver = createEmailCourseShadowRuntime({
				database: db,
			}).observeDelivery
			sync = {
				sendNow: (row) =>
					executeValuePathEmailIntent({
						repository,
						emailListProvider,
						intent: row,
						config,
						shadowObserver,
					}),
				budget: drovrSendBudget(redis, syncSend.perMinute),
			}
		} else {
			await log.warn('drovr.executor.sync_send_unavailable', {
				reviewReasons: allowlist.reviewReasons,
			})
		}
	}

	const result = await acceptDrovrIntent({
		repository,
		intent: parsed.data,
		findKitSubscriberId,
		evergreen: parseDrovrEvergreenConfig(process.env),
		unsubscribeInKit: createKitUnsubscriber({
			apiKey: env.KIT_V4_API_KEY ?? process.env.CONVERTKIT_V4_API_KEY,
		}),
		subscribeInKit: createKitFormSubscriber({
			apiKey: env.KIT_V4_API_KEY ?? process.env.CONVERTKIT_V4_API_KEY,
		}),
		linkKitSubscriber: async (contactId, kitSubscriberId) => {
			const linked = await linkKitSubscriberIdentity(
				{
					findProviderIdentity: (provider, externalId) =>
						repository.findProviderIdentity(provider, externalId),
					findKitSubscriberIdForContact: findKitSubscriberId,
					createProviderIdentity: (input) =>
						repository.createProviderIdentity(input),
				},
				contactId,
				kitSubscriberId,
				new Date().toISOString(),
			).catch(async (error) => {
				await log.warn('drovr.executor.kit_identity_link_failed', {
					contactId,
					error: error instanceof Error ? error.message : String(error),
				})
				return undefined
			})
			if (linked) {
				await log.info('drovr.executor.kit_identity_link', {
					contactId,
					outcome: linked,
				})
			}
		},
		...sync,
	})

	await log.info('drovr.executor.intent', {
		tenantId: parsed.data.tenantId,
		journeyId: parsed.data.journeyId,
		kind: parsed.data.kind,
		idempotencyKey: parsed.data.idempotencyKey,
		status: result.status,
		sync: sync.sendNow !== undefined,
		...('intentId' in result ? { intentId: result.intentId } : {}),
		...(result.status === 'retry'
			? { retryAfterMs: result.retryAfterMs, reason: result.reason }
			: {}),
	})

	switch (result.status) {
		case 'unsupported':
			return problem(
				422,
				'unsupported-intent',
				'ai-hero has no executor for this intent',
				result.reason,
				result.hint,
			)
		case 'contact-missing':
			return problem(
				404,
				'contact-not-found',
				'Contact is unknown to ai-hero',
				`No contact ${parsed.data.contactId}.`,
				'drovr contact ids are ai-hero contact ids; the contact must exist before its journey sends.',
			)
		case 'accepted':
			return NextResponse.json(result, { status: 202 })
		case 'completed':
			return NextResponse.json(result, { status: 200 })
		case 'blocked':
			return NextResponse.json(result, { status: 200 })
		case 'retry':
		case 'failed':
			return NextResponse.json(result, { status: 200 })
		default:
			return problem(
				500,
				'executor-failure',
				'Unexpected executor result',
				'The executor returned a result this route does not know.',
				'Check the deployment; drovr keeps the intent retryable.',
			)
	}
})
