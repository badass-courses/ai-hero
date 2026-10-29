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
import { readRecoveryStanding } from '@/lib/skills-course/recovery-standing'
import {
	createRecoveryStandingReader,
	recoveryLocalStandingEnabled,
} from '@/lib/skills-course/recovery-standing.server'
import { normalizeSkillsCourseRecoveryEmail } from '@/lib/subscriber-marketing/skills-course-recovery-token'
import { readSkillsCourseRecoveryToken } from '@/lib/subscriber-marketing/skills-course-recovery-token.server'
import { SubscriberSchema, type Subscriber } from '@/schemas/subscriber'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

import { SKILLS_HOSTED_RESUBSCRIBE_URL } from './skills-newsletter-config'

/**
 * Kit's subscriber, or the off-Kit standing in its shape. `stopped` and
 * `unknown` come only from the standing and never queue a send.
 */
type RecoverySubscriber = {
	id: Subscriber['id'] | string
	state?: Subscriber['state'] | 'stopped' | 'unknown'
}

type AuthorizedRecovery = {
	subscriber: RecoverySubscriber
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
		// A stop is final for this course (no restart after a lift), so it gets
		// no resubscribe detour. An unanswered stop state is a failed request.
		if (subscriber.state === 'stopped') {
			return { success: false as const, reason: 'stopped' as const }
		}
		if (subscriber.state === 'unknown') {
			return { success: false as const, reason: 'request-failed' as const }
		}
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
	const token = await readSkillsCourseRecoveryToken().catch(() => null)
	if (token?.valid) {
		const subscriber = await resolveSubscriberByEmail(
			token.payload.email,
			token.payload.kitSubscriberId,
		)
		if (!subscriber || String(subscriber.id) !== token.payload.kitSubscriberId) {
			return null
		}
		return {
			subscriber,
			source: SKILLS_COURSE_RECOVERY_SOURCE.signedRecoveryToken,
		}
	}

	const auth = await getServerAuthSession().catch(() => null)
	const sessionEmail = auth?.session?.user?.email
	if (!sessionEmail) return null
	const subscriber = await resolveSubscriberByEmail(sessionEmail)
	return subscriber
		? {
				subscriber,
				source: SKILLS_COURSE_RECOVERY_SOURCE.authenticatedSession,
			}
		: null
}

async function resolveSubscriberByEmail(
	email: string,
	expectedKitSubscriberId?: string,
): Promise<RecoverySubscriber | null> {
	const expectedEmail = normalizeSkillsCourseRecoveryEmail(email)
	if (recoveryLocalStandingEnabled()) {
		return resolveLocalSubscriber(expectedEmail, expectedKitSubscriberId)
	}
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

/**
 * Off-Kit standing (family 8): the directory, local course entry and local
 * plus drovr stops. Subscribed reads as Kit's `active`; not found is not
 * identified, as a missing Kit subscriber was.
 */
async function resolveLocalSubscriber(
	email: string,
	expectedKitSubscriberId?: string,
): Promise<RecoverySubscriber | null> {
	const standing = await readRecoveryStanding({
		email,
		expectedKitSubscriberId,
		reader: createRecoveryStandingReader(),
	})
	if (standing.state === 'subscribed') {
		return { id: standing.kitSubscriberId, state: 'active' }
	}
	// No identity in the log line: state and reason only.
	await log.info('skills.course.lesson_one_recovery_standing', {
		state: standing.state,
		reason: standing.reason,
	})
	if (standing.state === 'not-found') return null
	return { id: expectedKitSubscriberId ?? '', state: standing.state }
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
