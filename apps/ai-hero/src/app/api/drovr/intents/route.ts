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
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { and, eq } from 'drizzle-orm'

/**
 * drovr's executor endpoint: the SendPort adapter for tenant org-aihero.
 *
 * drovr's ContactActor posts an intent here inside its outbox guard. The
 * answer steers drovr: 202 accepted means the sender cron owns delivery
 * and the completion arrives later through POST /events; 200 completed
 * carries the completion inline for an intent ai-hero already finished;
 * 200 blocked means ai-hero's gates refused and a human must look.
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

	const result = await acceptDrovrIntent({
		repository: new DrizzleCaptureMarketingRepository(db),
		intent: parsed.data,
		findKitSubscriberId,
	})

	await log.info('drovr.executor.intent', {
		tenantId: parsed.data.tenantId,
		journeyId: parsed.data.journeyId,
		kind: parsed.data.kind,
		idempotencyKey: parsed.data.idempotencyKey,
		status: result.status,
		...('intentId' in result ? { intentId: result.intentId } : {}),
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
