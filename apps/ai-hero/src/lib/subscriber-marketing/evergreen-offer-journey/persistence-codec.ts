/* oxlint-disable anti-slop(no-unknown-parameters) -- Every unknown here is persisted JSON decoded immediately by the named Zod schema. */

import { z } from 'zod'

import {
	EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
	EVERGREEN_OFFER_CURRENCY,
	EVERGREEN_OFFER_MAX_USES,
	EVERGREEN_OFFER_PRODUCT_ID,
	type EligibilityFacts,
	type EvergreenOfferJourneyDefinition,
	type EvergreenOfferStimulus,
	type JourneyDomainEvent,
	type ScheduleWakeIntent,
	type SideEffectIntent,
	type TransitionReceipt,
} from './domain'
import type { JourneyLedgerCommit } from './ports'
import type { JourneyRestorationError } from './restoration'
import {
	parseContactId,
	parseContentResourceId,
	parseCouponId,
	parseEntryFactId,
	parseIanaTimeZone,
	parseIntentKey,
	parseIsoInstant,
	parseJourneyId,
	parseMessageSlotId,
	parsePresentationBundleId,
	parseStimulusId,
	parseVerifiedUserId,
	parseWakeId,
	type ParseResult,
} from './primitives'

export const EVERGREEN_OFFER_JOURNEY_COMMIT_EVIDENCE_FORMAT =
	'evergreen-offer-journey.commit-evidence.v1' as const

export type JourneyCommitEvidence = {
	readonly format: typeof EVERGREEN_OFFER_JOURNEY_COMMIT_EVIDENCE_FORMAT
	readonly expectedVersion: number | null
	readonly stimulus: JourneyLedgerCommit['stimulus']
	readonly currentFacts: JourneyLedgerCommit['currentFacts']
	readonly definition: JourneyLedgerCommit['definition']
	readonly decidedAt: JourneyLedgerCommit['decidedAt']
}

export type JourneyPayloadRestorationResult<Value> =
	| { readonly ok: true; readonly value: Value }
	| { readonly ok: false; readonly error: JourneyRestorationError }

const ContactId = parsedString(parseContactId)
const ContentResourceId = parsedString(parseContentResourceId)
const CouponId = parsedString(parseCouponId)
const EntryFactId = parsedString(parseEntryFactId)
const IntentKey = parsedString(parseIntentKey)
const IsoInstant = parsedString(parseIsoInstant)
const JourneyId = parsedString(parseJourneyId)
const MessageSlotId = parsedString(parseMessageSlotId)
const PresentationBundleId = parsedString(parsePresentationBundleId)
const StimulusId = parsedString(parseStimulusId)
const VerifiedUserId = parsedString(parseVerifiedUserId)
const WakeId = parsedString(parseWakeId)
const IanaTimeZone = parsedString(parseIanaTimeZone)
const NonBlank = z.string().trim().min(1)

const DeadlineTimeZone = z.union([
	z
		.object({
			type: z.literal('BrowserEntryHeader'),
			headerName: z.literal('x-vercel-ip-timezone'),
			timeZone: IanaTimeZone,
			capturedAt: IsoInstant,
		})
		.strict(),
	z
		.object({
			type: z.literal('ExplicitFallback'),
			reason: z.enum(['header-missing', 'header-invalid', 'legacy-entry']),
			timeZone: z.literal('America/Los_Angeles').transform((value) => {
				const parsed = parseIanaTimeZone(value)
				if (!parsed.ok)
					throw new Error('Pacific fallback is not an IANA time zone')
				return parsed.value
			}),
			capturedAt: IsoInstant,
		})
		.strict(),
])

const CouponTerms = z
	.object({
		productId: z.literal(EVERGREEN_OFFER_PRODUCT_ID),
		currency: z.literal(EVERGREEN_OFFER_CURRENCY),
		amountOffCents: z.literal(EVERGREEN_OFFER_AMOUNT_OFF_CENTS),
		maxUses: z.literal(EVERGREEN_OFFER_MAX_USES),
		exclusive: z.literal(true),
	})
	.strict()

const Presentation = z
	.object({
		bundleId: PresentationBundleId,
		subjectId: NonBlank,
		headlineId: NonBlank,
		openingId: NonBlank,
		ctaId: NonBlank,
	})
	.strict()

const WakePurpose = z.union([
	z.object({ type: z.literal('MessageSlot'), slotId: MessageSlotId }).strict(),
	z.object({ type: z.literal('CouponIssue') }).strict(),
	z.object({ type: z.literal('CouponExpiry') }).strict(),
])

const PurchaseFactSchema = z
	.object({
		purchaseId: NonBlank,
		offerProductFamily: z.literal('ai-coding-crash-course'),
		sourceProductId: NonBlank,
		purchasedAt: IsoInstant,
		sourceReference: NonBlank,
	})
	.strict()

const IssuedCouponSchema = z
	.object({
		couponId: CouponId,
		contactId: ContactId,
		issuedAt: IsoInstant,
		expiresAt: IsoInstant,
		deadlineTimeZone: DeadlineTimeZone,
		terms: CouponTerms,
		binding: z.union([
			z.object({ type: z.literal('AwaitingVerifiedUser') }).strict(),
			z
				.object({
					type: z.literal('BindingIntentCommitted'),
					verifiedUserId: VerifiedUserId,
					intentKey: IntentKey,
					committedAt: IsoInstant,
				})
				.strict(),
			z
				.object({
					type: z.literal('BoundToVerifiedUser'),
					verifiedUserId: VerifiedUserId,
					boundAt: IsoInstant,
				})
				.strict(),
		]),
	})
	.strict()

const StimulusSchema: z.ZodTypeAny = z.union([
	z
		.object({
			type: z.literal('CourseSequenceExhausted'),
			stimulusId: StimulusId,
			entryFactId: EntryFactId,
			contactId: ContactId,
			valuePathId: NonBlank,
			exhaustedAt: IsoInstant,
			deadlineTimeZone: DeadlineTimeZone,
			sourceReference: NonBlank,
		})
		.strict(),
	z
		.object({
			type: z.literal('WakeDue'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			wakeId: WakeId,
			dueAt: IsoInstant,
			purpose: WakePurpose,
		})
		.strict(),
	z
		.object({
			type: z.literal('DeliverySettled'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			slotId: MessageSlotId,
			intentKey: IntentKey,
			settledAt: IsoInstant,
			outcome: z.union([
				z
					.object({
						type: z.literal('Applied'),
						providerReceiptId: NonBlank,
					})
					.strict(),
				z
					.object({ type: z.literal('MessageRefused'), reason: NonBlank })
					.strict(),
				z
					.object({
						type: z.literal('ContactUndeliverable'),
						reason: NonBlank,
					})
					.strict(),
				z.object({ type: z.literal('Ambiguous'), reason: NonBlank }).strict(),
			]),
		})
		.strict(),
	z
		.object({
			type: z.literal('CouponIssued'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			intentKey: IntentKey,
			coupon: IssuedCouponSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal('VerifiedUserObserved'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			verifiedUserId: VerifiedUserId,
			observedAt: IsoInstant,
			sourceReference: NonBlank,
		})
		.strict(),
	z
		.object({
			type: z.literal('CouponBoundToUser'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			intentKey: IntentKey,
			couponId: CouponId,
			verifiedUserId: VerifiedUserId,
			boundAt: IsoInstant,
		})
		.strict(),
	z
		.object({
			type: z.literal('ShadowNewsletterEntered'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			intentKey: IntentKey,
			enteredAt: IsoInstant,
			providerReceiptId: NonBlank,
		})
		.strict(),
	z
		.object({
			type: z.literal('PurchaseObserved'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			purchase: PurchaseFactSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal('UnsubscribeObserved'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			observedAt: IsoInstant,
			sourceReference: NonBlank,
		})
		.strict(),
	z
		.object({
			type: z.literal('SuppressionObserved'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			observedAt: IsoInstant,
			reason: NonBlank,
			sourceReference: NonBlank,
		})
		.strict(),
	z
		.object({
			type: z.literal('OperatorStopObserved'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			observedAt: IsoInstant,
			reason: NonBlank,
		})
		.strict(),
	z
		.object({
			type: z.literal('PermanentEffectRefusal'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			intentKey: IntentKey,
			observedAt: IsoInstant,
			reason: NonBlank,
			scope: z.literal('MessageLocal'),
			slotId: MessageSlotId,
		})
		.strict(),
	z
		.object({
			type: z.literal('PermanentEffectRefusal'),
			stimulusId: StimulusId,
			journeyId: JourneyId,
			intentKey: IntentKey,
			observedAt: IsoInstant,
			reason: NonBlank,
			scope: z.literal('Contact'),
		})
		.strict(),
])

const EligibilityFactsSchema: z.ZodTypeAny = z
	.object({
		contactId: ContactId,
		purchase: PurchaseFactSchema.nullable(),
		delivery: z.union([
			z.object({ type: z.literal('Eligible') }).strict(),
			z
				.object({ type: z.literal('Unsubscribed'), evidence: NonBlank })
				.strict(),
			z.object({ type: z.literal('Suppressed'), evidence: NonBlank }).strict(),
			z
				.object({ type: z.literal('Undeliverable'), evidence: NonBlank })
				.strict(),
		]),
		existingJourneyId: JourneyId.nullable(),
		automationControl: z.union([
			z.object({ type: z.literal('Enabled'), version: NonBlank }).strict(),
			z
				.object({
					type: z.literal('Stopped'),
					version: NonBlank,
					reason: NonBlank,
				})
				.strict(),
		]),
		evidenceVersion: NonBlank,
		readAt: IsoInstant,
	})
	.strict()

const MessageDefinitionSchema = z
	.object({
		slotId: MessageSlotId,
		contentResourceId: ContentResourceId,
		presentation: Presentation,
	})
	.strict()

const DefinitionSchema: z.ZodTypeAny = z
	.object({
		definitionVersion: NonBlank,
		messagePlanId: NonBlank,
		messagePlanSourceHash: NonBlank,
		contentRevision: NonBlank,
		presentationReviewRevision: NonBlank,
		bridge: z.tuple([
			MessageDefinitionSchema,
			MessageDefinitionSchema,
			MessageDefinitionSchema,
		]),
		pitch: z.tuple([
			MessageDefinitionSchema,
			MessageDefinitionSchema,
			MessageDefinitionSchema,
			MessageDefinitionSchema,
			MessageDefinitionSchema,
		]),
		couponTerms: CouponTerms,
	})
	.strict()

const SideEffectIntentSchema: z.ZodTypeAny = z.union([
	z
		.object({
			type: z.literal('SendMessage'),
			idempotencyKey: IntentKey,
			journeyId: JourneyId,
			contactId: ContactId,
			slotId: MessageSlotId,
			contentResourceId: ContentResourceId,
			presentation: Presentation,
			notBefore: IsoInstant,
			notAfter: IsoInstant,
			couponId: CouponId.nullable(),
		})
		.strict(),
	z
		.object({
			type: z.literal('IssueCoupon'),
			idempotencyKey: IntentKey,
			journeyId: JourneyId,
			contactId: ContactId,
			issueAt: IsoInstant,
			expiresAt: IsoInstant,
			terms: CouponTerms,
			deadlineTimeZone: DeadlineTimeZone,
		})
		.strict(),
	z
		.object({
			type: z.literal('BindCoupon'),
			idempotencyKey: IntentKey,
			journeyId: JourneyId,
			couponId: CouponId,
			contactId: ContactId,
			verifiedUserId: VerifiedUserId,
		})
		.strict(),
	z
		.object({
			type: z.literal('EnterShadowNewsletter'),
			idempotencyKey: IntentKey,
			journeyId: JourneyId,
			contactId: ContactId,
		})
		.strict(),
])

const ScheduleWakeSchema: z.ZodTypeAny = z
	.object({
		type: z.literal('ScheduleWake'),
		wakeId: WakeId,
		journeyId: JourneyId,
		dueAt: IsoInstant,
		purpose: WakePurpose,
	})
	.strict()

const Phase = z.enum([
	'bridge.running',
	'coupon.waiting',
	'coupon.awaitingReceipt',
	'pitch.running',
	'handoff.awaitingReceipt',
	'customer',
	'stopped',
	'complete',
])

const TransitionReceiptSchema: z.ZodTypeAny = z
	.object({
		stimulusId: StimulusId,
		journeyId: JourneyId,
		from: z.union([z.literal('not_started'), Phase]),
		to: Phase,
		committedAt: IsoInstant,
		evidenceVersion: NonBlank,
	})
	.strict()

const EventBase = { occurredAt: IsoInstant }
const DomainEventSchema: z.ZodTypeAny = z.union([
	z
		.object({
			...EventBase,
			type: z.literal('JourneyStarted'),
			details: z.object({ journeyId: JourneyId }).strict(),
		})
		.strict(),
	z
		.object({
			...EventBase,
			type: z.literal('MessageIntentCommitted'),
			details: z
				.object({
					slotId: MessageSlotId,
					idempotencyKey: IntentKey,
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			...EventBase,
			type: z.literal('MessageSettled'),
			details: z
				.object({
					slotId: MessageSlotId,
					intentKey: IntentKey,
					outcome: z.enum([
						'Applied',
						'MessageRefused',
						'ContactUndeliverable',
						'Ambiguous',
					]),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			...EventBase,
			type: z.literal('MessageMissed'),
			details: z
				.object({
					slotId: MessageSlotId,
					intentKey: IntentKey.nullable(),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			...EventBase,
			type: z.literal('CouponIntentCommitted'),
			details: z.object({ idempotencyKey: IntentKey }).strict(),
		})
		.strict(),
	z
		.object({
			...EventBase,
			type: z.literal('CouponRecorded'),
			details: z.object({ couponId: CouponId, expiresAt: IsoInstant }).strict(),
		})
		.strict(),
	z
		.object({
			...EventBase,
			type: z.literal('CouponBindingIntentCommitted'),
			details: z
				.object({
					couponId: CouponId,
					verifiedUserId: VerifiedUserId,
					intentKey: IntentKey,
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			...EventBase,
			type: z.literal('CouponBindingRecorded'),
			details: z
				.object({
					couponId: CouponId,
					bindingIntentKey: IntentKey,
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			...EventBase,
			type: z.literal('HandoffIntentCommitted'),
			details: z.object({ idempotencyKey: IntentKey }).strict(),
		})
		.strict(),
	z
		.object({
			...EventBase,
			type: z.literal('JourneyExited'),
			details: z
				.object({
					reason: z.enum([
						'Purchased',
						'Unsubscribed',
						'Suppressed',
						'OperatorStopped',
						'PermanentFailure',
						'EnteredShadowNewsletter',
					]),
				})
				.strict(),
		})
		.strict(),
])

const CommitEvidenceEnvelope: z.ZodTypeAny = z
	.object({
		format: z.literal(EVERGREEN_OFFER_JOURNEY_COMMIT_EVIDENCE_FORMAT),
		expectedVersion: z.number().int().positive().nullable(),
		stimulus: StimulusSchema,
		currentFacts: EligibilityFactsSchema,
		definition: DefinitionSchema,
		decidedAt: IsoInstant,
	})
	.strict()

export function journeyCommitEvidenceRecord(
	commit: JourneyLedgerCommit,
): JourneyCommitEvidence {
	return {
		format: EVERGREEN_OFFER_JOURNEY_COMMIT_EVIDENCE_FORMAT,
		expectedVersion: commit.expectedVersion,
		stimulus: commit.stimulus,
		currentFacts: commit.currentFacts,
		definition: commit.definition,
		decidedAt: commit.decidedAt,
	}
}

export function validatePersistedCommitEvidenceEnvelope(
	input: unknown,
	expected: {
		readonly stimulusId: string
		readonly stimulusType: string
		readonly journeyId: string
		readonly actorVersion: number
		readonly decidedAt: string
	},
): JourneyPayloadRestorationResult<JourneyCommitEvidence> {
	const parsed = decodeAs<JourneyCommitEvidence>(
		CommitEvidenceEnvelope,
		input,
		'commit evidence',
	)
	if (!parsed.ok) return parsed
	const record = parsed.value
	if (
		record.stimulus.stimulusId !== expected.stimulusId ||
		record.stimulus.type !== expected.stimulusType
	) {
		return failure('Commit evidence stimulus identity does not match its row')
	}
	if (record.decidedAt !== expected.decidedAt) {
		return failure('Commit evidence decision time does not match its row')
	}
	if ((record.expectedVersion ?? 0) + 1 !== expected.actorVersion) {
		return failure('Commit evidence expected version does not match its row')
	}
	if (
		record.stimulus.type !== 'CourseSequenceExhausted' &&
		record.stimulus.journeyId !== expected.journeyId
	) {
		return failure('Commit evidence journey identity does not match its row')
	}
	return parsed
}

export function restorePersistedSideEffectIntent(
	input: unknown,
): JourneyPayloadRestorationResult<SideEffectIntent> {
	return decodeAs<SideEffectIntent>(
		SideEffectIntentSchema,
		input,
		'side-effect intent',
	)
}

export function restorePersistedScheduleWake(
	input: unknown,
): JourneyPayloadRestorationResult<ScheduleWakeIntent> {
	return decodeAs<ScheduleWakeIntent>(
		ScheduleWakeSchema,
		input,
		'scheduled wake',
	)
}

export function restorePersistedTransitionReceipt(
	input: unknown,
): JourneyPayloadRestorationResult<TransitionReceipt> {
	return decodeAs<TransitionReceipt>(
		TransitionReceiptSchema,
		input,
		'transition receipt',
	)
}

export function restorePersistedDomainEvents(
	input: unknown,
): JourneyPayloadRestorationResult<readonly JourneyDomainEvent[]> {
	return decodeAs<readonly JourneyDomainEvent[]>(
		z.array(DomainEventSchema),
		input,
		'domain events',
	)
}

function decode(
	schema: z.ZodTypeAny,
	input: unknown,
	label: string,
): JourneyPayloadRestorationResult<unknown> {
	const parsed = schema.safeParse(input)
	if (parsed.success) return { ok: true, value: parsed.data }
	return failure(
		`${label} failed validation: ${parsed.error.issues
			.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
			.join('; ')}`,
	)
}

function decodeAs<Value>(
	schema: z.ZodTypeAny,
	input: unknown,
	label: string,
): JourneyPayloadRestorationResult<Value> {
	const parsed = decode(schema, input, label)
	if (!parsed.ok) return parsed
	// SAFETY: the complete persisted value passed the domain-specific schema.
	return { ok: true, value: parsed.value as Value }
}

function parsedString<Value extends string>(
	parser: (value: string) => ParseResult<Value>,
) {
	return z.string().transform((input, context): Value => {
		const parsed = parser(input)
		if (parsed.ok && parsed.value === input) return parsed.value
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'Value failed domain parsing',
		})
		return z.NEVER
	})
}

function failure<Value = never>(
	reason: string,
): JourneyPayloadRestorationResult<Value> {
	return { ok: false, error: { type: 'JourneyDecodeFailure', reason } }
}
