import { log } from '@/server/logger'
import { Effect } from 'effect'

import type { DeadlineTimeZoneEvidence } from './course-sequence-exhaustion'
import type { EmailCourseDatabase } from './email-course-drizzle-ledger'
import { createDrizzleEmailCourseShadowLedger } from './email-course-drizzle-ledger'
import {
	createDrovrParityReceiptSink,
	type DrovrParityOptions,
} from './email-course-drovr-parity-receipt-sink'
import { AI_HERO_SKILLS_WORKFLOW_COURSE_V1 } from './email-course/definition'
import type {
	EmailCoursePlanningState,
	EmailCourseStimulus,
	ScheduleEvidence,
} from './email-course/domain'
import {
	deriveCourseRunId,
	parseContactId,
	parseEventId,
	parseIanaTimeZone,
	parseIsoInstant,
	parseStimulusId,
	type CourseRunId,
	type ParseResult,
} from './email-course/primitives'
import type {
	EmailCourseDefinitionRegistry,
	EmailCourseLedger,
} from './email-course/ports'
import { createEmailCourseScheduler } from './email-course/scheduler'
import { createAdvanceEmailCourse } from './email-course/service'

export const EMAIL_COURSE_RUNTIME_MODE = 'Shadow' as const
const SHADOW_CONTROL_VERSION = 'email-course-shadow.v1' as const
const SHADOW_ENABLED_AT = must(
	parseIsoInstant('1970-01-01T00:00:00.000Z'),
	'shadow enabled time',
)

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

export function createEmailCourseShadowRuntime(args: {
	database: EmailCourseDatabase
	warn?: typeof log.warn
	parity?: Omit<DrovrParityOptions, 'schedule'>
}): EmailCourseShadowRuntime {
	const definition = AI_HERO_SKILLS_WORKFLOW_COURSE_V1
	const ledger = createDrizzleEmailCourseShadowLedger(args.database, definition)
	const definitions: EmailCourseDefinitionRegistry = {
		get: () => Effect.succeed(definition),
	}

	const runSafely = async (
		stimulus: EmailCourseStimulus,
	): Promise<EmailCourseShadowObservationResult> => {
		try {
			const parityTasks: Promise<void>[] = []
			const advance = createAdvanceEmailCourse({
				ledger,
				definitions,
				// Shadow planning is explicitly authorized for comparison only. This
				// adapter never reads or writes AI_AutomationControl and cannot send.
				controls: {
					readEffective: () =>
						Effect.succeed({
							type: 'Enabled' as const,
							version: SHADOW_CONTROL_VERSION,
							enabledAt: SHADOW_ENABLED_AT,
						}),
				},
				communication: {
					decide: () => Effect.succeed({ type: 'Allow' as const }),
				},
				scheduler: createEmailCourseScheduler(),
				parityReceiptSink: createDrovrParityReceiptSink({
					...args.parity,
					schedule: (task) => {
						parityTasks.push(task())
					},
				}),
			})
			const result = await Effect.runPromise(advance({ stimulus }))
			await Promise.allSettled(parityTasks)
			const runId = stimulusRunId(stimulus)
			const status =
				result.decision.type === 'Ignored'
					? 'ignored'
					: result.replayedStimulus
						? 'replayed'
						: 'committed'
			await infoWithoutThrow({
				stimulusType: stimulus.type,
				status,
				runId,
			})
			return { status, runId }
		} catch (cause) {
			await warnWithoutThrow(args.warn ?? log.warn, cause)
			return {
				status: 'failed',
				reason: cause instanceof Error ? cause.message : String(cause),
			}
		}
	}

	return {
		observeSignup: async (observation) => {
			const parsed = signupStimulus(observation)
			return parsed.ok
				? runSafely(parsed.value)
				: { status: 'skipped', reason: parsed.reason }
		},
		observeDelivery: async (observation) => {
			const context = await loadObservationContext(
				ledger,
				observation.courseEntryEventId,
			)
			if (!context.ok) return context.result
			const currentIntent = context.state.currentIntent
			if (!currentIntent) {
				return { status: 'skipped', reason: 'shadow-current-intent-missing' }
			}
			if (currentIntent.contentResourceId !== observation.emailResourceId) {
				return {
					status: 'skipped',
					reason: 'legacy-delivery-does-not-match-shadow-intent',
				}
			}
			const completedAt = parseIsoInstant(observation.completedAt)
			const stimulusId = parseStimulusId(
				`shadow:delivery:${observation.legacyIntentId}`,
			)
			if (!completedAt.ok || !stimulusId.ok) {
				return { status: 'skipped', reason: 'legacy-delivery-invalid' }
			}
			return runSafely({
				type: 'DeliverySettled',
				stimulusId: stimulusId.value,
				runId: context.runId,
				intentId: currentIntent.id,
				outcome: {
					type: 'Applied',
					deliveryReceiptId: `legacy-intent:${observation.legacyIntentId}`,
					appliedAt: completedAt.value,
				},
				occurredAt: completedAt.value,
			})
		},
		observeAnswer: async (observation) => {
			const context = await loadObservationContext(
				ledger,
				observation.courseEntryEventId,
			)
			if (!context.ok) return context.result
			const sentStep = findStepByResource(observation.sentEmailResourceId)
			const selectedStep = observation.selectedNextEmailResourceId
				? findStepByResource(observation.selectedNextEmailResourceId)
				: undefined
			const selectedAt = parseIsoInstant(observation.selectedAt)
			const answerEventId = parseEventId(observation.contactEventId)
			const stimulusId = parseStimulusId(
				`shadow:answer:${observation.contactEventId}`,
			)
			if (
				!sentStep ||
				!selectedStep ||
				!selectedAt.ok ||
				!answerEventId.ok ||
				!stimulusId.ok
			) {
				return { status: 'skipped', reason: 'legacy-answer-invalid' }
			}
			return runSafely({
				type: 'AnswerSelected',
				stimulusId: stimulusId.value,
				runId: context.runId,
				answerEventId: answerEventId.value,
				sentStepId: sentStep.stepId,
				selectedPathId: selectedStep.pathId,
				selectedNextStepId: selectedStep.stepId,
				occurredAt: selectedAt.value,
			})
		},
	}
}

function signupStimulus(
	observation: EmailCourseShadowSignupObservation,
):
	| {
			ok: true
			value: Extract<EmailCourseStimulus, { type: 'ExplicitSignup' }>
	  }
	| { ok: false; reason: string } {
	const contactId = parseContactId(observation.contactId)
	const entryEventId = parseEventId(observation.courseEntryEventId)
	const occurredAt = parseIsoInstant(observation.subscribedAt)
	const stimulusId = parseStimulusId(
		`shadow:signup:${observation.courseEntryEventId}`,
	)
	const scheduleEvidence = restoreScheduleEvidence(
		observation.deadlineTimeZone,
		observation.subscribedAt,
	)
	if (
		!contactId.ok ||
		!entryEventId.ok ||
		!occurredAt.ok ||
		!stimulusId.ok ||
		!scheduleEvidence
	) {
		return { ok: false, reason: 'legacy-signup-invalid' }
	}
	return {
		ok: true,
		value: {
			type: 'ExplicitSignup',
			stimulusId: stimulusId.value,
			contactId: contactId.value,
			courseId: AI_HERO_SKILLS_WORKFLOW_COURSE_V1.courseId,
			entryEventId: entryEventId.value,
			scheduleEvidence,
			occurredAt: occurredAt.value,
		},
	}
}

async function loadObservationContext(
	ledger: EmailCourseLedger,
	courseEntryEventId: string,
): Promise<
	| { ok: true; runId: CourseRunId; state: EmailCoursePlanningState }
	| { ok: false; result: EmailCourseShadowObservationResult }
> {
	const entryEventId = parseEventId(courseEntryEventId)
	if (!entryEventId.ok) {
		return {
			ok: false,
			result: { status: 'skipped', reason: 'course-entry-event-invalid' },
		}
	}
	const runId = deriveCourseRunId({
		courseId: AI_HERO_SKILLS_WORKFLOW_COURSE_V1.courseId,
		entryEventId: entryEventId.value,
	})
	try {
		const state = await Effect.runPromise(ledger.load(runId))
		return state
			? { ok: true, runId, state }
			: {
					ok: false,
					result: { status: 'skipped', reason: 'shadow-course-run-missing' },
				}
	} catch (cause) {
		return {
			ok: false,
			result: {
				status: 'failed',
				reason: cause instanceof Error ? cause.message : String(cause),
			},
		}
	}
}

function restoreScheduleEvidence(
	evidence: DeadlineTimeZoneEvidence | undefined,
	fallbackCapturedAt: string,
): ScheduleEvidence | undefined {
	const capturedAt = parseIsoInstant(evidence?.capturedAt ?? fallbackCapturedAt)
	const timeZone = parseIanaTimeZone(
		evidence?.timeZone ?? 'America/Los_Angeles',
	)
	if (!capturedAt.ok || !timeZone.ok) return undefined
	return evidence?.type === 'BrowserEntryHeader'
		? {
				type: 'BrowserEntryHeader',
				headerName: 'x-vercel-ip-timezone',
				timeZone: timeZone.value,
				capturedAt: capturedAt.value,
			}
		: {
				type: 'ExplicitFallback',
				reason: evidence?.reason ?? 'header-missing',
				timeZone: 'America/Los_Angeles',
				capturedAt: capturedAt.value,
			}
}

function findStepByResource(contentResourceId: string) {
	for (const path of AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths) {
		const step = path.steps.find(
			(candidate) => candidate.contentResourceId === contentResourceId,
		)
		if (step) return step
	}
	return undefined
}

function stimulusRunId(stimulus: EmailCourseStimulus): CourseRunId {
	return stimulus.type === 'ExplicitSignup'
		? deriveCourseRunId({
				courseId: stimulus.courseId,
				entryEventId: stimulus.entryEventId,
			})
		: stimulus.runId
}

async function infoWithoutThrow(data: {
	stimulusType: EmailCourseStimulus['type']
	status: 'committed' | 'replayed' | 'ignored'
	runId: CourseRunId
}) {
	try {
		await log.info('email_course.shadow_observed', data)
	} catch {
		// Shadow observability cannot alter the production path that called it.
	}
}

async function warnWithoutThrow(warn: typeof log.warn, cause: unknown) {
	try {
		await warn('email_course.shadow_observation_failed', {
			error: cause instanceof Error ? cause.message : String(cause),
		})
	} catch {
		// A shadow observer can never alter the production path that called it.
	}
}

function must<Value>(result: ParseResult<Value>, field: string): Value {
	if (result.ok) return result.value
	throw new Error(`Invalid ${field}: ${result.error.reason}`)
}
