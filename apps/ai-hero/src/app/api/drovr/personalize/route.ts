import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { providerIdentity } from '@/db/schema'
import { env } from '@/env.mjs'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { createDrizzleValuePathLinkAnchorStore } from '@/lib/subscriber-marketing/drizzle-value-path-link-anchor'
import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
} from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import {
	DrovrPersonalizeRequestSchema,
	personalizeDrovrIntent,
} from '@/lib/subscriber-marketing/drovr-personalize'
import { getValuePathAnswerPages } from '@/lib/subscriber-marketing/value-path-answer-page'
import { problem } from '@/lib/http/problem-details'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'


const bearerMatches = (header: string | null, secret: string): boolean => {
	const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
	if (!token) return false
	const left = Buffer.from(token)
	const right = Buffer.from(secret)
	return left.length === right.length && timingSafeEqual(left, right)
}

/** Same executor bearer as /intents. The single token has no tenant claims;
 * only the authority tenant may obtain send-ready personalization. */
export const POST = withSkill(async (request: NextRequest) => {
	const secret = env.DROVR_EXECUTOR_TOKEN
	if (!secret) return problem(
			503,
			'executor-not-configured',
			'Executor not configured',
			'DROVR_EXECUTOR_TOKEN is not set on this deployment.',
			'Set the executor token, then retry.',
		)
	if (!bearerMatches(request.headers.get('authorization'), secret))
		return problem(
			401,
			'unauthorized',
			'Unauthorized',
			'The executor bearer token is missing or wrong.',
			'Send Authorization: Bearer <DROVR_EXECUTOR_TOKEN>.',
		)
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return malformed()
	}
	const parsed = DrovrPersonalizeRequestSchema.safeParse(body)
	if (!parsed.success) return malformed()
	if (parsed.data.tenantId !== DROVR_AUTHORITY_TENANT_ID)
		return problem(
			403,
			'tenant-mismatch',
			'Tenant not allowed',
			`Only ${DROVR_AUTHORITY_TENANT_ID} may obtain send-ready personalization.`,
			'Personalize under the authority tenant.',
		)
	const repository = new DrizzleCaptureMarketingRepository(db)
	// More than one Kit identity for a contact is ambiguous; never choose a
	// subscriber id arbitrarily when signing a path answer link.
	const identities = await db
		.select({ externalId: providerIdentity.externalId })
		.from(providerIdentity)
		.where(
			and(
				eq(providerIdentity.contactId, parsed.data.contactId),
				eq(providerIdentity.provider, 'kit'),
			),
		)
		.limit(2)
	const result = await personalizeDrovrIntent({
		repository,
		request: parsed.data,
		answerPages:
			parsed.data.journeyId === DROVR_SKILLS_COURSE_JOURNEY_ID
				? await getValuePathAnswerPages()
				: [],
		pathTokenSecret: env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
		baseUrl:
			env.NEXT_PUBLIC_URL ??
			env.NEXT_PUBLIC_SITE_URL ??
			'https://www.aihero.dev',
		kitSubscriberId:
			identities.length === 1 ? identities[0]?.externalId : undefined,
		identityConflict: identities.length > 1,
		// The first-issue anchor keeps a (contact, email) URL stable across
		// sends and retries; absent table = the previous dueAt + 30 days.
		linkAnchors: createDrizzleValuePathLinkAnchorStore(db),
		warn: log.warn,
	})
	return result
		? NextResponse.json(result)
		: problem(
				404,
				'unknown-contact',
				'Unknown contact',
				'No ai-hero contact has this contactId.',
				'Personalize a contact ai-hero has captured.',
			)
})

const malformed = () =>
	problem(
		400,
		'malformed-request',
		'Malformed request',
		'The body is not a valid personalize request.',
		'Send {tenantId, contactId, journeyId, emailKey, idempotencyKey, dueAt}.',
	)
