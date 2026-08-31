import { z } from 'zod'

import {
	parseIanaTimeZone,
	parseIsoInstant,
	type IanaTimeZone,
	type IsoInstant,
} from './evergreen-offer-journey/primitives'
import type { ContactEventRecord, NextAction, SideEffectIntent } from './types'
import {
	isContentCompleteSkillsWorkflowEmailResourceId,
	isTerminalSkillsWorkflowEmailResourceId,
	SKILLS_WORKFLOW_PATH_SLUGS,
} from './skills-workflow-path'

export const AIH_COURSE_ENTRY_EVIDENCE_FIELD = 'aih_course_entry_evidence'
export const EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT =
	'email-course.entry.v1' as const
export const COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE =
	'course.sequence-exhausted' as const
export const COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT =
	'email-course.sequence-exhausted.v1' as const
export const COURSE_DEADLINE_FALLBACK_TIME_ZONE = 'America/Los_Angeles' as const

export type DeadlineTimeZoneEvidence =
	| {
			readonly type: 'BrowserEntryHeader'
			readonly headerName: 'x-vercel-ip-timezone'
			readonly timeZone: IanaTimeZone
			readonly capturedAt: IsoInstant
	  }
	| {
			readonly type: 'ExplicitFallback'
			readonly reason: 'header-missing' | 'header-invalid' | 'legacy-entry'
			readonly timeZone: IanaTimeZone
			readonly capturedAt: IsoInstant
	  }

export type EmailCourseEntryPayload = {
	readonly format: typeof EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT
	readonly valuePathId: (typeof SKILLS_WORKFLOW_PATH_SLUGS)[number]
	readonly emailResourceId: string
	readonly deadlineTimeZone: DeadlineTimeZoneEvidence
}

export type CourseSequenceExhaustedPayload = {
	readonly format: typeof COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT
	readonly actor: {
		readonly actorId: string
		readonly contactId: string
		readonly valuePathId: (typeof SKILLS_WORKFLOW_PATH_SLUGS)[number]
		readonly courseEntryEventId: string
	}
	readonly exhaustedAt: IsoInstant
	readonly deadlineTimeZone: DeadlineTimeZoneEvidence
	readonly progression: {
		readonly from: {
			readonly intentId: string
			readonly idempotencyKey: string
			readonly emailResourceId: string
			readonly completedAt: IsoInstant
		}
		readonly trigger:
			| {
					readonly type: 'DailyDripDue'
					readonly evaluatedAt: IsoInstant
					readonly reason:
						| 'local-day-9am-due'
						| 'fallback-24h-due'
						| 'fixture-cadence-due'
			  }
			| {
					readonly type: 'DeliverySettled'
					readonly evaluatedAt: IsoInstant
					readonly plannedAvailableAt: IsoInstant
					readonly policy:
						| 'EighteenHourFloorThenLocalNine'
						| 'ExplicitTwentyFourHourFallback'
			  }
		readonly terminal: {
			readonly intentId: string
			readonly idempotencyKey: string
			readonly nextActionId: string
			readonly emailResourceId: string
		}
	}
	readonly sourceReferences: {
		readonly courseEntryEventId: string
		readonly priorIntentId: string
	}
}

export type EmailCourseEntryEventRecord = ContactEventRecord & {
	readonly eventType: 'value-path.entered'
	readonly payloadFormat: typeof EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT
	readonly domainPayload: EmailCourseEntryPayload
}

export type CourseSequenceExhaustionRecords = {
	readonly fact: ContactEventRecord & {
		readonly provider: 'ai-hero'
		readonly eventType: typeof COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE
		readonly domainFactKey: string
		readonly payloadFormat: typeof COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT
		readonly domainPayload: CourseSequenceExhaustedPayload
	}
	readonly nextAction: NextAction & {
		readonly type: 'advance-value-path'
		readonly status: 'planned'
	}
	readonly terminalIntent: SideEffectIntent & {
		readonly provider: 'kit'
		readonly type: 'send-value-path-email'
	}
}

export type CourseSequenceExhaustionCommitRequest = {
	readonly sourceIntentId: string
	readonly courseEntryEventId: string
	readonly records: CourseSequenceExhaustionRecords
}

export type CourseSequenceExhaustionCommitResult =
	| {
			readonly status: 'committed' | 'replayed'
			readonly records: CourseSequenceExhaustionRecords
	  }
	| {
			readonly status: 'legacy-terminal-intent-without-fact'
			readonly terminalIntentId: string
	  }

const IsoInstantSchema = parsedString(parseIsoInstant)
const IanaTimeZoneSchema = parsedString(parseIanaTimeZone)
const DeadlineTimeZoneEvidenceSchema: z.ZodType<
	DeadlineTimeZoneEvidence,
	z.ZodTypeDef,
	unknown
> =
	z.discriminatedUnion('type', [
		z
			.object({
				type: z.literal('BrowserEntryHeader'),
				headerName: z.literal('x-vercel-ip-timezone'),
				timeZone: IanaTimeZoneSchema,
				capturedAt: IsoInstantSchema,
			})
			.strict(),
		z
			.object({
				type: z.literal('ExplicitFallback'),
				reason: z.enum(['header-missing', 'header-invalid', 'legacy-entry']),
				timeZone: IanaTimeZoneSchema.refine(
					(value) => value === COURSE_DEADLINE_FALLBACK_TIME_ZONE,
				),
				capturedAt: IsoInstantSchema,
			})
			.strict(),
	])
const EmailCourseEntryPayloadSchema: z.ZodType<
	EmailCourseEntryPayload,
	z.ZodTypeDef,
	unknown
> = z
	.object({
		format: z.literal(EMAIL_COURSE_ENTRY_PAYLOAD_FORMAT),
		valuePathId: z.enum(SKILLS_WORKFLOW_PATH_SLUGS),
		emailResourceId: z.string().trim().min(1),
		deadlineTimeZone: DeadlineTimeZoneEvidenceSchema,
	})
	.strict()
const StoredCoursePayloadSchema = z
	.object({
		coursePayload: z
			.object({
				format: z.string().trim().min(1),
				payload: z.unknown(),
			})
			.strict(),
	})
	.passthrough()
const CourseSequenceExhaustedPayloadSchema: z.ZodType<
	CourseSequenceExhaustedPayload,
	z.ZodTypeDef,
	unknown
> =
	z
		.object({
			format: z.literal(COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT),
			actor: z
				.object({
					actorId: z.string().trim().min(1),
					contactId: z.string().trim().min(1),
					valuePathId: z.enum(SKILLS_WORKFLOW_PATH_SLUGS),
					courseEntryEventId: z.string().trim().min(1),
				})
				.strict(),
			exhaustedAt: IsoInstantSchema,
			deadlineTimeZone: DeadlineTimeZoneEvidenceSchema,
			progression: z
				.object({
					from: z
						.object({
							intentId: z.string().trim().min(1),
							idempotencyKey: z.string().trim().min(1),
							emailResourceId: z
								.string()
								.refine(isContentCompleteSkillsWorkflowEmailResourceId),
							completedAt: IsoInstantSchema,
						})
						.strict(),
					trigger: z.discriminatedUnion('type', [
						z
							.object({
								type: z.literal('DailyDripDue'),
								evaluatedAt: IsoInstantSchema,
								reason: z.enum([
									'local-day-9am-due',
									'fallback-24h-due',
									'fixture-cadence-due',
								]),
							})
							.strict(),
						z
							.object({
								type: z.literal('DeliverySettled'),
								evaluatedAt: IsoInstantSchema,
								plannedAvailableAt: IsoInstantSchema,
								policy: z.enum([
									'EighteenHourFloorThenLocalNine',
									'ExplicitTwentyFourHourFallback',
								]),
							})
							.strict(),
					]),
					terminal: z
						.object({
							intentId: z.string().trim().min(1),
							idempotencyKey: z.string().trim().min(1),
							nextActionId: z.string().trim().min(1),
							emailResourceId: z
								.string()
								.refine(isTerminalSkillsWorkflowEmailResourceId),
						})
						.strict(),
				})
				.strict(),
			sourceReferences: z
				.object({
					courseEntryEventId: z.string().trim().min(1),
					priorIntentId: z.string().trim().min(1),
				})
				.strict(),
		})
		.strict()
		.superRefine((value, context) => {
			if (
				value.actor.actorId !==
				`email-course:${value.actor.contactId}:${value.actor.valuePathId}` ||
				value.actor.courseEntryEventId !==
					value.sourceReferences.courseEntryEventId ||
				value.progression.from.intentId !==
					value.sourceReferences.priorIntentId ||
				value.progression.terminal.intentId ===
					value.progression.from.intentId
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Sequence exhaustion ownership references disagree',
				})
			}
		})

export function parseCourseSequenceExhaustionEnabled(value?: string) {
	return value?.trim().toLowerCase() === 'true'
}

export function deadlineTimeZoneEvidenceFromHeader(args: {
	headerValue: string | null | undefined
	capturedAt: string
	existingLearner?: boolean
}):
	| { readonly ok: true; readonly value: DeadlineTimeZoneEvidence }
	| {
			readonly ok: false
			readonly error: {
				readonly type: 'JourneyScheduleError'
				readonly reason: 'InvalidInstant'
				readonly detail: string
			}
	  } {
	const capturedAt = parseIsoInstant(args.capturedAt)
	if (!capturedAt.ok) {
		return {
			ok: false,
			error: {
				type: 'JourneyScheduleError',
				reason: 'InvalidInstant',
				detail: 'capturedAt is not a valid instant',
			},
		}
	}
	const parsedHeader = args.headerValue
		? parseIanaTimeZone(args.headerValue)
		: null
	if (parsedHeader?.ok) {
		return {
			ok: true,
			value: {
				type: 'BrowserEntryHeader',
				headerName: 'x-vercel-ip-timezone',
				timeZone: parsedHeader.value,
				capturedAt: capturedAt.value,
			},
		}
	}
	const fallback = parseIanaTimeZone(COURSE_DEADLINE_FALLBACK_TIME_ZONE)
	if (!fallback.ok) {
		return {
			ok: false,
			error: {
				type: 'JourneyScheduleError',
				reason: 'InvalidInstant',
				detail: 'Fallback time zone is invalid',
			},
		}
	}
	return {
		ok: true,
		value: {
			type: 'ExplicitFallback',
			reason: args.existingLearner
				? 'legacy-entry'
				: args.headerValue
					? 'header-invalid'
					: 'header-missing',
			timeZone: fallback.value,
			capturedAt: capturedAt.value,
		},
	}
}

export function serializeDeadlineTimeZoneEvidenceForKit(
	evidence: DeadlineTimeZoneEvidence,
) {
	return JSON.stringify(evidence)
}

export function parseStashedDeadlineTimeZoneEvidence(
	fields?: Record<string, unknown> | null,
) {
	const raw = fields?.[AIH_COURSE_ENTRY_EVIDENCE_FIELD]
	if (typeof raw !== 'string' || !raw.trim()) return undefined
	try {
		return restoreDeadlineTimeZoneEvidence(JSON.parse(raw))
	} catch {
		return undefined
	}
}

export function restoreDeadlineTimeZoneEvidence(
	input: unknown,
): DeadlineTimeZoneEvidence | undefined {
	const parsed = DeadlineTimeZoneEvidenceSchema.safeParse(input)
	return parsed.success ? parsed.data : undefined
}

export function withCoursePayload(
	payloadSummary: ContactEventRecord['payloadSummary'],
	format: string,
	payload: EmailCourseEntryPayload | CourseSequenceExhaustedPayload,
) {
	return {
		...payloadSummary,
		coursePayload: { format, payload },
	}
}

/* oxlint-disable anti-slop(no-unknown-parameters) -- This is the JSON-column boundary; the outer and nested domain schemas parse it before use. */
export function readCoursePayload(
	value: unknown,
): { format: string; payload: unknown } | undefined {
	const restored = StoredCoursePayloadSchema.safeParse(value)
	return restored.success
		? {
				format: restored.data.coursePayload.format,
				payload: restored.data.coursePayload.payload,
			}
		: undefined
}
/* oxlint-enable anti-slop(no-unknown-parameters) */

export function restoreEmailCourseEntryPayload(
	input: unknown,
): EmailCourseEntryPayload | undefined {
	const parsed = EmailCourseEntryPayloadSchema.safeParse(input)
	return parsed.success ? parsed.data : undefined
}

export function courseSequenceExhaustionFactKey(args: {
	contactId: string
	valuePathId: string
}) {
	return `email-course.sequence-exhausted:${args.contactId}:${args.valuePathId}`
}

export function restoreCourseSequenceExhaustedPayload(
	input: unknown,
): CourseSequenceExhaustedPayload | undefined {
	const parsed = CourseSequenceExhaustedPayloadSchema.safeParse(input)
	return parsed.success ? parsed.data : undefined
}

function parsedString<Value extends string>(
	parser: (input: string) =>
		| { readonly ok: true; readonly value: Value }
		| { readonly ok: false; readonly error: { readonly reason: string } },
) {
	return z.string().transform((input, context) => {
		const parsed = parser(input)
		if (parsed.ok) return parsed.value
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: parsed.error.reason,
		})
		return z.NEVER
	})
}
