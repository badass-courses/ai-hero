import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { providerIdentity } from '@/db/schema'
import { env } from '@/env.mjs'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
} from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import {
	DrovrPersonalizeRequestSchema,
	personalizeDrovrIntent,
} from '@/lib/subscriber-marketing/drovr-personalize'
import { getValuePathAnswerPages } from '@/lib/subscriber-marketing/value-path-answer-page'
import { withSkill } from '@/server/with-skill'

const problem = (status: number, error: string) =>
	NextResponse.json({ error }, { status })

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
	if (!secret) return problem(503, 'executor_not_configured')
	if (!bearerMatches(request.headers.get('authorization'), secret))
		return problem(401, 'unauthorized')
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return problem(400, 'malformed_request')
	}
	const parsed = DrovrPersonalizeRequestSchema.safeParse(body)
	if (!parsed.success) return problem(400, 'malformed_request')
	if (parsed.data.tenantId !== DROVR_AUTHORITY_TENANT_ID)
		return problem(403, 'tenant_mismatch')
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
	})
	return result ? NextResponse.json(result) : problem(404, 'unknown_contact')
})
