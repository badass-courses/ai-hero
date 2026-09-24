import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db'
import { env } from '@/env.mjs'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { personalizeDrovrIntent } from '@/lib/subscriber-marketing/drovr-personalize'
import {
	DROVR_AUTHORITY_TENANT_ID,
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SKILLS_COURSE_JOURNEY_ID,
} from '@/lib/subscriber-marketing/drovr-shadow-emitter'
import { getSkillsWorkflowEmailStep } from '@/lib/subscriber-marketing/skills-workflow-path'
import { getValuePathAnswerPages } from '@/lib/subscriber-marketing/value-path-answer-page'
import {
	authJsSecret,
	hashVerificationToken,
	newSignInToken,
	TEST_PRINCIPAL_SIGN_IN_TTL_MS,
	TestPrincipalRequestSchema,
	testPrincipalSignIn,
} from '@/lib/test-principals/test-principal'
import {
	problem,
	testPrincipalAuthProblem,
} from '@/lib/test-principals/test-principal-http'
import { mintTestPrincipalRecords } from '@/lib/test-principals/test-principal-store'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

/**
 * POST /api/drovr/test-principals mints (or returns, within its hour) the
 * throwaway principal for a drovr link-test run: a synthetic user and
 * contact, a one-time sign-in link, and the personalize variables for the
 * emails under test. No email is sent and nothing reaches Kit or drovr.
 */
export const POST = withSkill(async (request: NextRequest) => {
	const refused = testPrincipalAuthProblem(
		request.headers.get('authorization'),
		env.AIHERO_TEST_PRINCIPAL_TOKEN,
	)
	if (refused) return refused
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return malformed('The body is not JSON.')
	}
	const parsed = TestPrincipalRequestSchema.safeParse(body)
	if (!parsed.success) return malformed(parsed.error.issues[0]?.message ?? '')
	const input = parsed.data
	if (input.tenantId !== DROVR_AUTHORITY_TENANT_ID) {
		return problem(
			403,
			'tenant-mismatch',
			'Tenant not allowed',
			`Test principals exist only for ${DROVR_AUTHORITY_TENANT_ID}.`,
			'Mint under the authority tenant.',
		)
	}
	if (input.evergreenCoupon) {
		return problem(
			501,
			'evergreen-coupon-unavailable',
			'Synthetic coupons are not available yet',
			'The optional evergreen coupon ships separately (T3c).',
			'Mint without evergreenCoupon until T3c is deployed.',
		)
	}
	const secret = authJsSecret()
	if (!secret) {
		return problem(
			503,
			'sign-in-not-configured',
			'Sign-in is not configured',
			'Neither AUTH_SECRET nor NEXTAUTH_SECRET is set.',
			'Configure Auth.js before minting principals.',
		)
	}

	const now = new Date()
	const rawToken = newSignInToken()
	const tokenExpires = new Date(now.getTime() + TEST_PRINCIPAL_SIGN_IN_TTL_MS)
	const records = await mintTestPrincipalRecords(db, {
		runId: input.runId,
		now,
		tokenHash: hashVerificationToken(rawToken, secret),
		tokenExpires,
	})
	if (records.status === 'limit') {
		return problem(
			429,
			'test-principal-limit',
			'Too many live test principals',
			`${records.live} principals are live; at most 5 may exist at once.`,
			'DELETE finished principals, or wait for the hourly reaper.',
		)
	}

	const { identity } = records
	const repository = new DrizzleCaptureMarketingRepository(db)
	const answerPages = input.emailKeys.some((key) => getSkillsWorkflowEmailStep(key))
		? await getValuePathAnswerPages()
		: []
	const variables: Record<string, Record<string, string>> = {}
	for (const emailKey of input.emailKeys) {
		const answer = await personalizeDrovrIntent({
			repository,
			request: {
				tenantId: input.tenantId,
				contactId: identity.contactId,
				journeyId: getSkillsWorkflowEmailStep(emailKey)
					? DROVR_SKILLS_COURSE_JOURNEY_ID
					: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
				emailKey,
				idempotencyKey: `test-principal:${input.runId}:${emailKey}`,
				// Signed links expire with the principal's own clock, not now.
				dueAt: records.createdAt.toISOString(),
			},
			answerPages,
			pathTokenSecret: env.AI_HERO_VALUE_PATH_TOKEN_SECRET,
			baseUrl: request.nextUrl.origin,
		})
		variables[emailKey] = answer?.variables ?? {}
	}

	await log.info('drovr.test_principal.minted', {
		runId: input.runId,
		principalId: identity.principalId,
		status: records.status,
		emailKeyCount: input.emailKeys.length,
	})
	return NextResponse.json(
		{
			principalId: identity.principalId,
			contactId: identity.contactId,
			email: identity.email,
			signIn: testPrincipalSignIn({
				origin: request.nextUrl.origin,
				email: identity.email,
				rawToken,
				expiresAt: tokenExpires,
			}),
			variables,
			expiresAt: records.expiresAt.toISOString(),
		},
		{
			status: records.status === 'minted' ? 201 : 200,
			headers: { 'cache-control': 'no-store' },
		},
	)
})

const malformed = (detail: string) =>
	problem(
		400,
		'malformed-request',
		'Malformed request',
		detail,
		'Send {runId, tenantId, personas:["recipient"], emailKeys}.',
	)
