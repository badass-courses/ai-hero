import type { DeadlineTimeZoneEvidence } from '@/lib/subscriber-marketing/course-sequence-exhaustion'
import type { OptInAttribution } from '@/lib/subscriber-marketing/opt-in-attribution'

export const SKILLS_NEWSLETTER_SUBSCRIBED_EVENT =
	'skills-newsletter/subscribed' as const
export const SKILLS_COURSE_LESSON_ONE_RECOVERY_REQUESTED_EVENT =
	'skills-course/lesson-one-recovery.requested' as const
export const SKILLS_COURSE_RECOVERY_SOURCE = {
	authenticatedSession: 'authenticated-session',
	signedRecoveryToken: 'signed-recovery-token',
} as const

export type SkillsCourseRecoverySource =
	(typeof SKILLS_COURSE_RECOVERY_SOURCE)[keyof typeof SKILLS_COURSE_RECOVERY_SOURCE]

export type SkillsNewsletterSubscribed = {
	name: typeof SKILLS_NEWSLETTER_SUBSCRIBED_EVENT
	data: {
		kitSubscriberId: string
		email: string
		name?: string
		formId: number
		source: string
		subscribedAt: string
		deadlineTimeZone?: DeadlineTimeZoneEvidence
		signupGapLiveness?: {
			workSeen: number
			workDone: number
			oldestUnservedAgeHours: number | null
			oldestUnservedAt: string | null
		}
		optInAttribution?: OptInAttribution
	}
}

export type SkillsCourseLessonOneRecoveryRequested = {
	id: string
	name: typeof SKILLS_COURSE_LESSON_ONE_RECOVERY_REQUESTED_EVENT
	data: {
		/** Safe operator correlation value. It is not derived from customer data. */
		requestId: string
		/** Stable HMAC used for durable idempotency without exposing customer data. */
		recoveryKey: string
		requestedAt: string
		/** Trusted lookup key; never copy it into application logs. */
		kitSubscriberId: string
		source: SkillsCourseRecoverySource
	}
}
