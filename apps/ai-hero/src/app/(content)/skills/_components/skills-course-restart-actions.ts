'use server'

import { createHmac, randomUUID } from 'node:crypto'
import { cookies, headers } from 'next/headers'

import { env } from '@/env.mjs'

import {
	SKILLS_COURSE_LESSON_ONE_RECOVERY_REQUESTED_EVENT,
	SKILLS_COURSE_RECOVERY_SOURCE,
	type SkillsCourseLessonOneRecoveryRequested,
	type SkillsCourseRecoverySource,
} from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import {
	readRecoveryStanding,
	type RecoveryStanding,
} from '@/lib/skills-course/recovery-standing'
import { createRecoveryStandingReader } from '@/lib/skills-course/recovery-standing.server'
import { parseDrovrSignupDeliveryConfig } from '@/lib/subscriber-marketing/drovr-doi-signup'
import { requestDrovrDoiSignup } from '@/lib/subscriber-marketing/drovr-doi-signup.server'
import { parseOptInAttributionCookie } from '@/lib/subscriber-marketing/opt-in-attribution'
import { normalizeSkillsCourseRecoveryEmail } from '@/lib/subscriber-marketing/skills-course-recovery-token'
import { readSkillsCourseRecoveryToken } from '@/lib/subscriber-marketing/skills-course-recovery-token.server'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

import { SKILLS_FORM_ID } from './skills-newsletter-config'

type RecoveryIdentity = {
	email: string
	expectedKitSubscriberId?: string
	source: SkillsCourseRecoverySource
}

/** Queues one durable lesson-one recovery without trusting Kit browser cookies. */
export async function resendSkillsCourseLessonOne() {
	try {
		const identity = await resolveRecoveryIdentity()
		if (!identity) {
			return { success: false as const, reason: 'not-identified' as const }
		}

		const { email, expectedKitSubscriberId, source } = identity
		const standing = await resolveRecoveryStanding(email, expectedKitSubscriberId)
		// A stop is final for this course (no restart after a lift), so it gets
		// no resubscribe detour. An unanswered stop state is a failed request.
		if (standing.state === 'stopped') {
			return { success: false as const, reason: 'stopped' as const }
		}
		if (standing.state === 'unknown') {
			return { success: false as const, reason: 'request-failed' as const }
		}
		if (standing.state === 'not-found') {
			// The directory verified the identity but found no course entry.
			// Missing contacts or mismatched aliases are not authorization.
			if (standing.reason !== 'course-entry-not-found') {
				return { success: false as const, reason: 'not-identified' as const }
			}
			if (!parseDrovrSignupDeliveryConfig(env)) {
				return { success: false as const, reason: 'request-failed' as const }
			}
			const [cookieStore, headerStore] = await Promise.all([
				cookies(),
				headers(),
			])
			await requestDrovrDoiSignup({
				email,
				kitFormId: SKILLS_FORM_ID,
				page: headerStore.get('referer') ?? 'https://www.aihero.dev/skills',
				optInAttribution: parseOptInAttributionCookie(
					cookieStore.get('ft_attr')?.value,
				),
				entry: 'recovery',
			})
			return {
				success: false as const,
				reason: 'confirmation-required' as const,
				confirmationUrl: '/confirm',
			}
		}

		const { kitSubscriberId } = standing
		if (expectedKitSubscriberId && kitSubscriberId !== expectedKitSubscriberId) {
			return { success: false as const, reason: 'not-identified' as const }
		}
		const requestId = randomUUID()
		const requestedAt = new Date().toISOString()
		const recoveryKey = createHmac('sha256', recoverySecret())
			.update(`skills-course-lesson-one-recovery:${kitSubscriberId}`)
			.digest('hex')
		const event: SkillsCourseLessonOneRecoveryRequested = {
			id: `skills-course-lesson-one-recovery:${requestId}`,
			name: SKILLS_COURSE_LESSON_ONE_RECOVERY_REQUESTED_EVENT,
			data: {
				requestId,
				recoveryKey,
				requestedAt,
				kitSubscriberId,
				source,
			},
		}
		await inngest.send(event)
		return { success: true as const }
	} catch {
		// Provider errors and tokens can contain customer identity. Keep both out.
		await log.error('skills.course.lesson_one_recovery_enqueue_failed', {
			outcome: 'not-queued',
		})
		return { success: false as const, reason: 'request-failed' as const }
	}
}

async function resolveRecoveryIdentity(): Promise<RecoveryIdentity | null> {
	const token = await readSkillsCourseRecoveryToken().catch(() => null)
	if (token?.valid) {
		return {
			email: normalizeSkillsCourseRecoveryEmail(token.payload.email),
			expectedKitSubscriberId: token.payload.kitSubscriberId,
			source: SKILLS_COURSE_RECOVERY_SOURCE.signedRecoveryToken,
		}
	}

	const auth = await getServerAuthSession().catch(() => null)
	const sessionEmail = auth?.session?.user?.email
	if (!sessionEmail) return null
	return {
		email: normalizeSkillsCourseRecoveryEmail(sessionEmail),
		source: SKILLS_COURSE_RECOVERY_SOURCE.authenticatedSession,
	}
}

async function resolveRecoveryStanding(
	email: string,
	expectedKitSubscriberId?: string,
): Promise<RecoveryStanding> {
	const standing = await readRecoveryStanding({
		email,
		expectedKitSubscriberId,
		reader: createRecoveryStandingReader(),
	})
	// No identity in the log line: state and reason only.
	await log.info('skills.course.lesson_one_recovery_standing', {
		state: standing.state,
		...('reason' in standing ? { reason: standing.reason } : {}),
	})
	return standing
}

function recoverySecret() {
	// No committed fallback (sec-037): a missing secret fails here.
	const secret = process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET
	if (!secret) throw new Error('Recovery key is unavailable')
	return secret
}
