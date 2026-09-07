import { contactEvent } from '@/db/schema'
import {
	evergreenOfferJourneyIntent as intents,
	evergreenOfferJourneyWake as wakes,
} from '@/db/evergreen-offer-journey-schema'
import { and, asc, eq, gt, lte, or } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { Effect, Either } from 'effect'
import { z } from 'zod'
import {
	COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE,
	readCoursePayload,
	restoreCourseSequenceExhaustedPayload,
} from '../course-sequence-exhaustion'
import { AI_HERO_SKILLS_WORKFLOW_COURSE_V1 } from '../email-course/definition'
import { deriveCourseRunId, parseEventId } from '../email-course/primitives'
import { courseSequenceExhaustedStimulusFromContactEvent } from './course-sequence-exhausted-adapter'
import type { JourneyLedger } from './ports'
import { parseStimulusId } from './primitives'
import type {
	CourseSequenceExhausted,
	ScheduleWakeIntent,
	SideEffectIntent,
} from './domain'

const cursorSchema = z
	.object({
		at: z.string().datetime({ precision: 3 }),
		id: z.string().min(1).max(500),
	})
	.strict()
const pageInput = z
	.object({
		now: z.date(),
		after: cursorSchema.optional(),
		limit: z.number().int().min(1).max(100),
	})
	.strict()
export type ScanCursor = z.infer<typeof cursorSchema>
export type ReaderPageInput = z.infer<typeof pageInput>
export type ReaderFailure = {
	readonly type: 'ReaderFailure'
	readonly reason: 'InvalidPage' | 'ReadUnavailable'
}
export type ScanPage<Value> = {
	readonly candidates: readonly Value[]
	readonly held: readonly {
		cursor: ScanCursor
		reason: 'InvalidSource' | 'InvalidCanonicalEvidence'
	}[]
	readonly scanned: number
	readonly nextCursor: ScanCursor | null
	/** End of this bounded occurrence/due range, not proof of no future/backdated inserts. */
	readonly end: boolean
}
const provider = z.enum(['fixture', 'front', 'kit', 'ai-hero'])
const identityEvidence = z
	.object({
		source: provider,
		strength: z.enum(['weak', 'medium', 'strong']),
		email: z.string().optional(),
		name: z.string().optional(),
		userId: z.string().optional(),
		providerIdentity: z.object({ provider, externalId: z.string() }).optional(),
	})
	.passthrough()
const sourceRow = z.object({
	id: z.string().min(1),
	contactId: z.string().min(1),
	providerIdentityId: z.string().min(1),
	provider: z.literal('ai-hero'),
	providerEventId: z.string().min(1),
	providerReference: z.string().min(1),
	eventType: z.literal(COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE),
	semanticIdempotencyKey: z.string().min(1),
	schemaVersion: z.literal(1),
	occurredAt: z.date(),
	createdAt: z.date(),
	privacyLevel: z.enum(['public', 'internal', 'restricted']),
	identityEvidence,
	payloadSummary: z
		.object({
			summary: z.string(),
			keywords: z.array(z.string()),
			restrictedPayloadStored: z.literal(false),
		})
		.passthrough(),
})

/** Decode only committed ContactEvent evidence. No fallback, inferred completion,
 * provider membership or invented entry fact. Owning payload codec pins both paths.
 */
export function restoreSourceCandidate(
	input: unknown,
): CourseSequenceExhausted | null {
	const decoded = sourceRow.safeParse(input)
	if (!decoded.success) return null
	const row = decoded.data
	const payload = restoreCourseSequenceExhaustedPayload(
		readCoursePayload(row.payloadSummary)?.payload,
	)
	if (
		!payload ||
		Math.floor(Date.parse(payload.exhaustedAt) / 1000) !==
			Math.floor(row.occurredAt.getTime() / 1000)
	)
		return null
	const entry = parseEventId(payload.actor.courseEntryEventId)
	if (!entry.ok) return null
	const runId = deriveCourseRunId({
		courseId: AI_HERO_SKILLS_WORKFLOW_COURSE_V1.courseId,
		entryEventId: entry.value,
	})
	// Both existing atomic producers remain accepted; neither reference may drift
	// from its owning payload. No new event spelling or enrollment policy.
	const legacyReference =
		row.providerReference === `value-path:${payload.actor.valuePathId}` &&
		row.providerEventId === row.semanticIdempotencyKey
	const courseReference =
		row.providerReference === `email-course:${runId}` &&
		row.providerEventId === row.id
	if (!legacyReference && !courseReference) return null
	const result = courseSequenceExhaustedStimulusFromContactEvent({
		...row,
		occurredAt: row.occurredAt.toISOString(),
		createdAt: row.createdAt.toISOString(),
	})
	return result.ok &&
		result.value.entryFactId === row.id &&
		result.value.contactId === row.contactId
		? result.value
		: null
}

/** SELECT-only candidate readers. Caller supplies fresh shared Clock now per page.
 * A cursor orders occurrence/due time, not commit time: repeat/overlap scans to
 * handle late insertions and retain held rows for repair/revisit. No audience cutoff.
 * Candidates never grant admission, authority, scheduling or provider permission.
 */
export function createBoundedJourneyReaders(
	database: Pick<MySql2Database, 'select'>,
	ledger: Pick<JourneyLedger, 'findCommittedStimulus'>,
) {
	function read<Value>(
		input: ReaderPageInput,
		work: (request: ReaderPageInput) => Promise<Value>,
	) {
		return Effect.tryPromise({
			try: () => work(pageInput.parse(input)),
			catch: (cause): ReaderFailure => ({
				type: 'ReaderFailure',
				reason: cause instanceof z.ZodError ? 'InvalidPage' : 'ReadUnavailable',
			}),
		})
	}
	return {
		source(input: ReaderPageInput) {
			return read(input, async (request) => {
				const rows = await database
					.select()
					.from(contactEvent)
					.where(
						and(
							eq(contactEvent.eventType, COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE),
							lte(contactEvent.occurredAt, request.now),
							request.after
								? or(
										gt(contactEvent.occurredAt, new Date(request.after.at)),
										and(
											eq(contactEvent.occurredAt, new Date(request.after.at)),
											gt(contactEvent.id, request.after.id),
										),
									)
								: undefined,
						),
					)
					.orderBy(asc(contactEvent.occurredAt), asc(contactEvent.id))
					.limit(request.limit)
				const page = emptyPage<CourseSequenceExhausted>(request)
				for (const row of rows) {
					const cursor = scanned(page, row.occurredAt, row.id)
					const candidate = restoreSourceCandidate(row)
					if (candidate) page.candidates.push(candidate)
					else page.held.push({ cursor, reason: 'InvalidSource' })
				}
				return finish(page, request)
			})
		},
		wakes(input: ReaderPageInput) {
			return read(input, async (request) => {
				const rows = await database
					.select()
					.from(wakes)
					.where(
						and(
							eq(wakes.status, 'Pending'),
							lte(wakes.dueAt, request.now),
							request.after
								? or(
										gt(wakes.dueAt, new Date(request.after.at)),
										and(
											eq(wakes.dueAt, new Date(request.after.at)),
											gt(wakes.wakeId, request.after.id),
										),
									)
								: undefined,
						),
					)
					.orderBy(asc(wakes.dueAt), asc(wakes.wakeId))
					.limit(request.limit)
				const page = emptyPage<ScheduleWakeIntent>(request)
				for (const row of rows) {
					const cursor = scanned(page, row.dueAt, row.wakeId)
					const decision = await canonical(row.originatingStimulusId)
					const wake = decision?.wakeIntents.find(
						(value) => value.wakeId === row.wakeId,
					)
					if (
						wake &&
						wake.journeyId === row.journeyId &&
						new Date(wake.dueAt).getTime() === row.dueAt.getTime()
					)
						page.candidates.push(wake)
					else page.held.push({ cursor, reason: 'InvalidCanonicalEvidence' })
				}
				return finish(page, request)
			})
		},
		intents(input: ReaderPageInput) {
			return read(input, async (request) => {
				const rows = await database
					.select()
					.from(intents)
					.where(
						and(
							eq(intents.status, 'Pending'),
							lte(intents.availableAt, request.now),
							request.after
								? or(
										gt(intents.availableAt, new Date(request.after.at)),
										and(
											eq(intents.availableAt, new Date(request.after.at)),
											gt(intents.idempotencyKey, request.after.id),
										),
									)
								: undefined,
						),
					)
					.orderBy(asc(intents.availableAt), asc(intents.idempotencyKey))
					.limit(request.limit)
				const page = emptyPage<{
					intent: SideEffectIntent
					window: 'Open' | 'Expired'
				}>(request)
				for (const row of rows) {
					const cursor = scanned(page, row.availableAt, row.idempotencyKey)
					const decision = await canonical(row.originatingStimulusId)
					const intent = decision?.sideEffectIntents.find(
						(value) => value.idempotencyKey === row.idempotencyKey,
					)
					const expectedAt =
						intent?.type === 'SendMessage'
							? intent.notBefore
							: intent?.type === 'IssueCoupon'
								? intent.issueAt
								: decision?.transitionReceipt.committedAt
					if (
						!intent ||
						intent.journeyId !== row.journeyId ||
						!expectedAt ||
						new Date(expectedAt).getTime() !== row.availableAt.getTime()
					) {
						page.held.push({ cursor, reason: 'InvalidCanonicalEvidence' })
						continue
					}
					const expiresAt =
						intent.type === 'SendMessage'
							? intent.notAfter
							: intent.type === 'IssueCoupon'
								? intent.expiresAt
								: null
					page.candidates.push({
						intent,
						window:
							expiresAt && new Date(expiresAt) <= request.now
								? 'Expired'
								: 'Open',
					})
				}
				return finish(page, request)
			})
		},
	}
	async function canonical(id: string) {
		const parsed = parseStimulusId(id)
		if (!parsed.ok) return null
		const result = await Effect.runPromise(
			Effect.either(ledger.findCommittedStimulus(parsed.value)),
		)
		if (Either.isLeft(result)) {
			if (result.left.type === 'JourneyDecodeFailure') return null
			throw new Error('Canonical read unavailable')
		}
		return result.right?.decision.type === 'Accepted'
			? result.right.decision
			: null
	}
}
function emptyPage<Value>(input: ReaderPageInput) {
	return {
		candidates: [] as Value[],
		held: [] as {
			cursor: ScanCursor
			reason: 'InvalidSource' | 'InvalidCanonicalEvidence'
		}[],
		scanned: 0,
		nextCursor: input.after ?? null,
	}
}
function scanned(
	page: { scanned: number; nextCursor: ScanCursor | null },
	at: Date,
	id: string,
) {
	const cursor = cursorSchema.parse({ at: at.toISOString(), id })
	page.scanned += 1
	page.nextCursor = cursor
	return cursor
}
function finish<Value>(
	page: ReturnType<typeof emptyPage<Value>>,
	input: ReaderPageInput,
): ScanPage<Value> {
	return { ...page, end: page.scanned < input.limit }
}
