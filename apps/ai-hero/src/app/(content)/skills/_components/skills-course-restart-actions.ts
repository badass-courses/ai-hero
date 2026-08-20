'use server'

import { createHmac, randomUUID } from 'node:crypto'

import { emailListProvider } from '@/coursebuilder/email-list-provider'
import {
	SKILLS_COURSE_LESSON_ONE_RECOVERY_REQUESTED_EVENT,
	SKILLS_COURSE_RECOVERY_SOURCE,
	type SkillsCourseLessonOneRecoveryRequested,
	type SkillsCourseRecoverySource,
} from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import { normalizeSkillsCourseRecoveryEmail } from '@/lib/subscriber-marketing/skills-course-recovery-token'
import { readSkillsCourseRecoveryToken } from '@/lib/subscriber-marketing/skills-course-recovery-token.server'
import { SubscriberSchema, type Subscriber } from '@/schemas/subscriber'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

import { SKILLS_HOSTED_RESUBSCRIBE_URL } from './skills-newsletter-config'

type AuthorizedRecovery = {
	subscriber: Subscriber
	source: SkillsCourseRecoverySource
}

/** Queues one durable lesson-one recovery without trusting Kit browser cookies. */
export async function resendSkillsCourseLessonOne() {
	try {
		const authorization = await resolveAuthorizedRecovery()
		if (!authorization) {
			return { success: false as const, reason: 'not-identified' as const }
		}

		const { subscriber, source } = authorization
		if (subscriber.state !== 'active') {
			return {
				success: false as const,
				reason: 'confirmation-required' as const,
				confirmationUrl: SKILLS_HOSTED_RESUBSCRIBE_URL,
			}
		}

		const requestId = randomUUID()
		const requestedAt = new Date().toISOString()
		const kitSubscriberId = String(subscriber.id)
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

async function resolveAuthorizedRecovery(): Promise<AuthorizedRecovery | null> {
	const auth = await getServerAuthSession().catch(() => null)
	const sessionEmail = auth?.session?.user?.email
	if (sessionEmail) {
		const subscriber = await resolveSubscriberByEmail(sessionEmail)
		return subscriber
			? {
					subscriber,
					source: SKILLS_COURSE_RECOVERY_SOURCE.authenticatedSession,
				}
			: null
	}

	const token = await readSkillsCourseRecoveryToken()
	if (!token.valid) return null
	const subscriber = await resolveSubscriberByEmail(token.payload.email)
	if (!subscriber || String(subscriber.id) !== token.payload.kitSubscriberId) {
		return null
	}
	return {
		subscriber,
		source: SKILLS_COURSE_RECOVERY_SOURCE.signedRecoveryToken,
	}
}

async function resolveSubscriberByEmail(email: string) {
	const expectedEmail = normalizeSkillsCourseRecoveryEmail(email)
	const subscriber = SubscriberSchema.safeParse(
		await emailListProvider.getSubscriberByEmail(expectedEmail),
	)
	if (!subscriber.success) return null
	return subscriber.data.email_address &&
		normalizeSkillsCourseRecoveryEmail(subscriber.data.email_address) ===
			expectedEmail
		? subscriber.data
		: null
}

function recoverySecret() {
	const secret =
		process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET ??
		(process.env.NODE_ENV === 'production'
			? undefined
			: 'dev-value-path-token-secret')
	if (!secret) throw new Error('Recovery key is unavailable')
	return secret
}
