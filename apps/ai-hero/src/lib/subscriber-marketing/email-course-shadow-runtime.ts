import type { log } from '@/server/logger'

import type { DeadlineTimeZoneEvidence } from './course-sequence-exhaustion'
import type { EmailCourseDatabase } from './email-course-drizzle-ledger'
import type { DrovrParityOptions } from './email-course-drovr-parity-receipt-sink'
import type { CourseRunId } from './email-course/primitives'

export const EMAIL_COURSE_RUNTIME_MODE = 'Shadow' as const

export type EmailCourseShadowObservationResult =
	| {
			status: 'committed' | 'replayed' | 'ignored'
			runId: CourseRunId
	  }
	| {
			status: 'skipped' | 'failed'
			reason: string
	  }

export type EmailCourseShadowSignupObservation = {
	contactId: string
	courseEntryEventId: string
	subscribedAt: string
	deadlineTimeZone?: DeadlineTimeZoneEvidence
}

export type EmailCourseShadowDeliveryObservation = {
	courseEntryEventId: string
	legacyIntentId: string
	emailResourceId: string
	completedAt: string
}

export type EmailCourseShadowAnswerObservation = {
	courseEntryEventId: string
	contactEventId: string
	sentEmailResourceId: string
	selectedNextEmailResourceId?: string
	selectedAt: string
}

export type EmailCourseShadowRuntime = {
	observeSignup: (
		observation: EmailCourseShadowSignupObservation,
	) => Promise<EmailCourseShadowObservationResult>
	observeDelivery: (
		observation: EmailCourseShadowDeliveryObservation,
	) => Promise<EmailCourseShadowObservationResult>
	observeAnswer: (
		observation: EmailCourseShadowAnswerObservation,
	) => Promise<EmailCourseShadowObservationResult>
}

const RETIRED_RESULT: EmailCourseShadowObservationResult = {
	status: 'skipped',
	reason: 'shadow-runtime-retired',
}

/**
 * The comparison runtime is retired. Its adapter remains temporarily so
 * live callers keep their authority behavior while scheduling no shadow
 * planning, ledger, parity, or network work.
 */
export function createEmailCourseShadowRuntime(_args: {
	database: EmailCourseDatabase
	warn?: typeof log.warn
	parity?: Omit<DrovrParityOptions, 'schedule'>
}): EmailCourseShadowRuntime {
	return {
		observeSignup: async () => RETIRED_RESULT,
		observeDelivery: async () => RETIRED_RESULT,
		observeAnswer: async () => RETIRED_RESULT,
	}
}
