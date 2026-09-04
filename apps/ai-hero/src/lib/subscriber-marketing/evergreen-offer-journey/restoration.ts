import { z } from 'zod'

import { addPitchMessagePlan, buildBridgeMessagePlan } from './calendar'
import {
	EVERGREEN_OFFER_AMOUNT_OFF_CENTS,
	EVERGREEN_OFFER_CURRENCY,
	EVERGREEN_OFFER_FALLBACK_TIME_ZONE,
	EVERGREEN_OFFER_JOURNEY_SCHEMA_VERSION,
	EVERGREEN_OFFER_MAX_USES,
	EVERGREEN_OFFER_PRODUCT_ID,
	type EvergreenOfferJourneyAggregate,
	type MessageSlot,
} from './domain'
import {
	EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT,
	type JourneySnapshotRecord,
} from './persistence-contract'
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
	couponBindingIntentKey,
	deriveJourneyId,
	messageIntentKey,
	parseVerifiedUserId,
	type ContactId,
	type ContentResourceId,
	type CouponId,
	type EntryFactId,
	type IanaTimeZone,
	type IntentKey,
	type IsoInstant,
	type JourneyId,
	type MessageSlotId,
	type PresentationBundleId,
	type VerifiedUserId,
} from './primitives'

export { EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT }

export type JourneyRestorationError = {
	readonly type: 'JourneyDecodeFailure'
	readonly reason: string
}

export type JourneyRestorationResult =
	| { readonly ok: true; readonly value: EvergreenOfferJourneyAggregate }
	| { readonly ok: false; readonly error: JourneyRestorationError }

const ContactIdSchema = parsedString<ContactId>(parseContactId)
const ContentResourceIdSchema = parsedString<ContentResourceId>(
	parseContentResourceId,
)
const CouponIdSchema = parsedString<CouponId>(parseCouponId)
const EntryFactIdSchema = parsedString<EntryFactId>(parseEntryFactId)
const IanaTimeZoneSchema = parsedString<IanaTimeZone>(parseIanaTimeZone)
const IsoInstantSchema = parsedString<IsoInstant>(parseIsoInstant)
const MessageSlotIdSchema = parsedString<MessageSlotId>(parseMessageSlotId)
const PresentationBundleIdSchema = parsedString<PresentationBundleId>(
	parsePresentationBundleId,
)
const VerifiedUserIdSchema = parsedString<VerifiedUserId>(parseVerifiedUserId)
const JourneyIdSchema = parsedString<JourneyId>(parseJourneyId)
const IntentKeySchema = parsedString<IntentKey>(parseIntentKey)
const NonBlankString = z
	.string()
	.min(1)
	.refine((value) => value.trim() === value, 'Expected canonical whitespace')

const DeadlineTimeZoneEvidenceSchema = z.discriminatedUnion('type', [
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
			timeZone: IanaTimeZoneSchema,
			capturedAt: IsoInstantSchema,
		})
		.strict(),
])

const CouponTermsSchema = z
	.object({
		productId: z.literal(EVERGREEN_OFFER_PRODUCT_ID),
		currency: z.literal(EVERGREEN_OFFER_CURRENCY),
		amountOffCents: z.literal(EVERGREEN_OFFER_AMOUNT_OFF_CENTS),
		maxUses: z.literal(EVERGREEN_OFFER_MAX_USES),
		exclusive: z.literal(true),
	})
	.strict()

const CouponBindingSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('AwaitingVerifiedUser') }).strict(),
	z
		.object({
			type: z.literal('BindingIntentCommitted'),
			verifiedUserId: VerifiedUserIdSchema,
			intentKey: IntentKeySchema,
			committedAt: IsoInstantSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal('BoundToVerifiedUser'),
			verifiedUserId: VerifiedUserIdSchema,
			boundAt: IsoInstantSchema,
		})
		.strict(),
])

const IssuedCouponSchema = z
	.object({
		couponId: CouponIdSchema,
		contactId: ContactIdSchema,
		issuedAt: IsoInstantSchema,
		expiresAt: IsoInstantSchema,
		deadlineTimeZone: DeadlineTimeZoneEvidenceSchema,
		terms: CouponTermsSchema,
		binding: CouponBindingSchema,
	})
	.strict()

const SelectedPresentationSchema = z
	.object({
		bundleId: PresentationBundleIdSchema,
		subjectId: NonBlankString,
		headlineId: NonBlankString,
		openingId: NonBlankString,
		ctaId: NonBlankString,
	})
	.strict()

const MessageDefinitionSchema = z
	.object({
		slotId: MessageSlotIdSchema,
		contentResourceId: ContentResourceIdSchema,
		presentation: SelectedPresentationSchema,
	})
	.strict()

const EvergreenOfferJourneyDefinitionSchema = z
	.object({
		definitionVersion: NonBlankString,
		messagePlanId: NonBlankString,
		messagePlanSourceHash: NonBlankString,
		contentRevision: NonBlankString,
		presentationReviewRevision: NonBlankString,
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
		couponTerms: CouponTermsSchema,
	})
	.strict()

const MessageSlotBase = {
	slotId: MessageSlotIdSchema,
	contentResourceId: ContentResourceIdSchema,
	presentation: SelectedPresentationSchema,
	phase: z.enum(['Bridge', 'Pitch']),
	dueAt: IsoInstantSchema,
	windowEndsAt: IsoInstantSchema,
}

const MessageSlotSchema = z.discriminatedUnion('status', [
	z.object({ ...MessageSlotBase, status: z.literal('Scheduled') }).strict(),
	z
		.object({
			...MessageSlotBase,
			status: z.literal('IntentCommitted'),
			intentKey: IntentKeySchema,
			committedAt: IsoInstantSchema,
		})
		.strict(),
	z
		.object({
			...MessageSlotBase,
			status: z.literal('Applied'),
			intentKey: IntentKeySchema,
			settledAt: IsoInstantSchema,
			providerReceiptId: NonBlankString,
		})
		.strict(),
	z
		.object({
			...MessageSlotBase,
			status: z.literal('Refused'),
			intentKey: IntentKeySchema,
			settledAt: IsoInstantSchema,
			reason: NonBlankString,
		})
		.strict(),
	z
		.object({
			...MessageSlotBase,
			status: z.literal('Ambiguous'),
			intentKey: IntentKeySchema,
			settledAt: IsoInstantSchema,
			reason: NonBlankString,
		})
		.strict(),
	z
		.object({
			...MessageSlotBase,
			status: z.literal('Missed'),
			intentKey: IntentKeySchema.nullable(),
			missedAt: IsoInstantSchema,
			reason: z.literal('DeliveryWindowClosed'),
		})
		.strict(),
])

const SelectedMessagePlanSchema = z
	.object({
		definitionVersion: NonBlankString,
		messagePlanId: NonBlankString,
		messagePlanSourceHash: NonBlankString,
		contentRevision: NonBlankString,
		presentationReviewRevision: NonBlankString,
		bridge: z.tuple([MessageSlotSchema, MessageSlotSchema, MessageSlotSchema]),
		pitch: z.array(MessageSlotSchema).max(5),
	})
	.strict()

const PurchaseFactSchema = z
	.object({
		purchaseId: NonBlankString,
		offerProductFamily: z.literal('ai-coding-crash-course'),
		sourceProductId: NonBlankString,
		purchasedAt: IsoInstantSchema,
		sourceReference: NonBlankString,
	})
	.strict()

const PurchasedExitSchema = z
	.object({ type: z.literal('Purchased'), purchase: PurchaseFactSchema })
	.strict()
const StoppedExitSchema = z.discriminatedUnion('type', [
	z
		.object({ type: z.literal('Unsubscribed'), observedAt: IsoInstantSchema })
		.strict(),
	z
		.object({
			type: z.literal('Suppressed'),
			observedAt: IsoInstantSchema,
			reason: NonBlankString,
		})
		.strict(),
	z
		.object({
			type: z.literal('OperatorStopped'),
			observedAt: IsoInstantSchema,
			reason: NonBlankString,
		})
		.strict(),
	z
		.object({
			type: z.literal('PermanentFailure'),
			observedAt: IsoInstantSchema,
			reason: NonBlankString,
		})
		.strict(),
])
const CompleteExitSchema = z
	.object({
		type: z.literal('EnteredShadowNewsletter'),
		enteredAt: IsoInstantSchema,
	})
	.strict()

const JourneyBaseSchema = z
	.object({
		schemaVersion: z.literal(EVERGREEN_OFFER_JOURNEY_SCHEMA_VERSION),
		journeyId: JourneyIdSchema,
		entryFactId: EntryFactIdSchema,
		contactId: ContactIdSchema,
		valuePathId: NonBlankString,
		exhaustedAt: IsoInstantSchema,
		deadlineTimeZone: DeadlineTimeZoneEvidenceSchema,
		definition: EvergreenOfferJourneyDefinitionSchema,
		messagePlan: SelectedMessagePlanSchema,
		version: z.number().int().positive(),
	})
	.strict()

const EvergreenOfferJourneyAggregateSchema = z.discriminatedUnion('phase', [
	JourneyBaseSchema.extend({
		phase: z.literal('bridge.running'),
		coupon: z.null(),
	}),
	JourneyBaseSchema.extend({
		phase: z.literal('coupon.waiting'),
		coupon: z.null(),
	}),
	JourneyBaseSchema.extend({
		phase: z.literal('coupon.awaitingReceipt'),
		coupon: z.null(),
	}),
	JourneyBaseSchema.extend({
		phase: z.literal('pitch.running'),
		coupon: IssuedCouponSchema,
	}),
	JourneyBaseSchema.extend({
		phase: z.literal('handoff.awaitingReceipt'),
		coupon: IssuedCouponSchema,
	}),
	JourneyBaseSchema.extend({
		phase: z.literal('customer'),
		coupon: IssuedCouponSchema.nullable(),
		exit: PurchasedExitSchema,
	}),
	JourneyBaseSchema.extend({
		phase: z.literal('stopped'),
		coupon: IssuedCouponSchema.nullable(),
		exit: StoppedExitSchema,
	}),
	JourneyBaseSchema.extend({
		phase: z.literal('complete'),
		coupon: IssuedCouponSchema,
		exit: CompleteExitSchema,
	}),
])

const SnapshotEnvelopeSchema = z
	.object({
		format: z.literal(EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT),
		journeyId: JourneyIdSchema,
		actorVersion: z.number().int().positive(),
		aggregate: EvergreenOfferJourneyAggregateSchema,
	})
	.strict()

export function encodeEvergreenOfferJourneySnapshot(
	aggregate: EvergreenOfferJourneyAggregate,
): string {
	return JSON.stringify({
		format: EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT,
		journeyId: aggregate.journeyId,
		actorVersion: aggregate.version,
		aggregate,
	})
}

export function journeySnapshotRecord(
	aggregate: EvergreenOfferJourneyAggregate,
): JourneySnapshotRecord {
	return {
		format: EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT,
		journeyId: aggregate.journeyId,
		actorVersion: aggregate.version,
		snapshotJson: encodeEvergreenOfferJourneySnapshot(aggregate),
	}
}

export function restoreEvergreenOfferJourneySnapshot(
	input: string,
): JourneyRestorationResult {
	let decodedInput: unknown
	try {
		decodedInput = JSON.parse(input)
	} catch {
		return decodeFailure('Snapshot is not valid JSON')
	}
	const parsed = SnapshotEnvelopeSchema.safeParse(decodedInput)
	if (!parsed.success) {
		return decodeFailure(
			parsed.error.issues
				.map(
					(issue) => `${issue.path.join('.') || 'snapshot'}: ${issue.message}`,
				)
				.join('; '),
		)
	}
	const envelope = parsed.data
	if (envelope.journeyId !== envelope.aggregate.journeyId) {
		return decodeFailure(
			'Envelope journey ID does not match aggregate journey ID',
		)
	}
	if (envelope.actorVersion !== envelope.aggregate.version) {
		return decodeFailure(
			'Envelope actor version does not match aggregate version',
		)
	}
	const invariantFailure = validateAggregateInvariants(envelope.aggregate)
	if (invariantFailure) return decodeFailure(invariantFailure)
	const aggregate: EvergreenOfferJourneyAggregate = envelope.aggregate
	return { ok: true, value: aggregate }
}

function validateAggregateInvariants(
	aggregate: EvergreenOfferJourneyAggregate,
): string | null {
	if (aggregate.journeyId !== deriveJourneyId(aggregate.entryFactId)) {
		return 'Journey ID does not match the entry fact ID'
	}
	if (
		aggregate.deadlineTimeZone.type === 'ExplicitFallback' &&
		aggregate.deadlineTimeZone.timeZone !== EVERGREEN_OFFER_FALLBACK_TIME_ZONE
	) {
		return 'Explicit fallback must use America/Los_Angeles'
	}
	const metadata = [
		'definitionVersion',
		'messagePlanId',
		'messagePlanSourceHash',
		'contentRevision',
		'presentationReviewRevision',
	] as const
	for (const key of metadata) {
		if (aggregate.definition[key] !== aggregate.messagePlan[key]) {
			return `Message plan ${key} does not match the pinned definition`
		}
	}
	for (let index = 0; index < aggregate.definition.bridge.length; index += 1) {
		const definitionSlot = aggregate.definition.bridge[index]
		const messageSlot = aggregate.messagePlan.bridge[index]
		if (
			definitionSlot === undefined ||
			!sameMessageDefinition(definitionSlot, messageSlot)
		) {
			return `Bridge slot ${index + 1} does not match the pinned definition`
		}
	}
	const canonicalBridge = buildBridgeMessagePlan({
		exhaustedAt: aggregate.exhaustedAt,
		deadlineTimeZone: aggregate.deadlineTimeZone,
		definition: aggregate.definition,
	})
	if (!canonicalBridge.ok) {
		return `Pinned bridge schedule is invalid: ${canonicalBridge.error.detail}`
	}
	for (
		let index = 0;
		index < canonicalBridge.value.messagePlan.bridge.length;
		index += 1
	) {
		if (
			!sameSlotSchedule(
				canonicalBridge.value.messagePlan.bridge[index],
				aggregate.messagePlan.bridge[index],
			)
		) {
			return `Bridge slot ${index + 1} does not match the canonical schedule`
		}
	}
	const definitions = [
		...aggregate.definition.bridge,
		...aggregate.definition.pitch,
	]
	if (new Set(definitions.map((definition) => definition.slotId)).size !== 8) {
		return 'Pinned message slot IDs must be unique'
	}
	if (
		new Set(definitions.map((definition) => definition.contentResourceId))
			.size !== 8
	) {
		return 'Pinned content resource IDs must be unique'
	}
	const slots = [
		...aggregate.messagePlan.bridge,
		...aggregate.messagePlan.pitch,
	]
	if (
		slots.some(
			(slot) =>
				Date.parse(slot.dueAt) >= Date.parse(slot.windowEndsAt) ||
				(slot.phase === 'Bridge' &&
					!aggregate.messagePlan.bridge.includes(slot)) ||
				(slot.phase === 'Pitch' && !aggregate.messagePlan.pitch.includes(slot)),
		)
	) {
		return 'Message slot phase or delivery window is invalid'
	}
	for (const slot of slots) {
		if (
			'intentKey' in slot &&
			slot.intentKey !== null &&
			slot.intentKey !==
				messageIntentKey({
					journeyId: aggregate.journeyId,
					contentResourceId: slot.contentResourceId,
				})
		) {
			return `Slot ${slot.slotId} has a non-semantic intent key`
		}
	}
	if (aggregate.messagePlan.pitch.length !== 0) {
		if (!aggregate.coupon) {
			return 'Pitch slots require the coupon that created their schedule'
		}
		if (
			aggregate.messagePlan.pitch.length !== aggregate.definition.pitch.length
		) {
			return 'Pitch plan must be empty or contain all five pinned slots'
		}
		for (let index = 0; index < aggregate.definition.pitch.length; index += 1) {
			const definitionSlot = aggregate.definition.pitch[index]
			const messageSlot = aggregate.messagePlan.pitch[index]
			if (
				definitionSlot === undefined ||
				!sameMessageDefinition(definitionSlot, messageSlot)
			) {
				return `Pitch slot ${index + 1} does not match the pinned definition`
			}
		}
	}
	if (
		(aggregate.phase === 'bridge.running' ||
			aggregate.phase === 'coupon.waiting' ||
			aggregate.phase === 'coupon.awaitingReceipt') &&
		aggregate.messagePlan.pitch.length !== 0
	) {
		return `${aggregate.phase} cannot contain pitch slots`
	}
	if (
		(aggregate.phase === 'pitch.running' ||
			aggregate.phase === 'handoff.awaitingReceipt' ||
			aggregate.phase === 'complete') &&
		aggregate.messagePlan.pitch.length !== 5
	) {
		return `${aggregate.phase} requires all five pitch slots`
	}
	if (aggregate.coupon) {
		if (aggregate.coupon.issuedAt !== canonicalBridge.value.couponIssueAt) {
			return 'Coupon issue time does not match the canonical Thursday opening'
		}
		if (aggregate.messagePlan.pitch.length !== 5) {
			return 'A recorded coupon requires all five canonical pitch slots'
		}
		const canonicalPitch = addPitchMessagePlan({
			messagePlan: canonicalBridge.value.messagePlan,
			coupon: aggregate.coupon,
			definition: aggregate.definition,
		})
		if (!canonicalPitch.ok) {
			return `Pinned pitch schedule is invalid: ${canonicalPitch.error.detail}`
		}
		for (let index = 0; index < canonicalPitch.value.pitch.length; index += 1) {
			if (
				!sameSlotSchedule(
					canonicalPitch.value.pitch[index],
					aggregate.messagePlan.pitch[index],
				)
			) {
				return `Pitch slot ${index + 1} does not match the canonical schedule`
			}
		}
		if (aggregate.coupon.contactId !== aggregate.contactId) {
			return 'Coupon contact does not match the actor contact'
		}
		if (
			Date.parse(aggregate.coupon.issuedAt) >=
			Date.parse(aggregate.coupon.expiresAt)
		) {
			return 'Coupon expiry must be after coupon issuance'
		}
		if (
			aggregate.coupon.binding.type === 'BindingIntentCommitted' &&
			aggregate.coupon.binding.intentKey !==
				couponBindingIntentKey({
					journeyId: aggregate.journeyId,
					verifiedUserId: aggregate.coupon.binding.verifiedUserId,
				})
		) {
			return 'Coupon binding has a non-semantic intent key'
		}
		if (
			!sameTimeZoneEvidence(
				aggregate.coupon.deadlineTimeZone,
				aggregate.deadlineTimeZone,
			)
		) {
			return 'Coupon deadline evidence does not match the actor evidence'
		}
	}
	return null
}

function sameTimeZoneEvidence(
	left: EvergreenOfferJourneyAggregate['deadlineTimeZone'],
	right: EvergreenOfferJourneyAggregate['deadlineTimeZone'],
) {
	if (
		left.type !== right.type ||
		left.timeZone !== right.timeZone ||
		left.capturedAt !== right.capturedAt
	) {
		return false
	}
	if (left.type === 'BrowserEntryHeader') {
		return (
			right.type === 'BrowserEntryHeader' &&
			left.headerName === right.headerName
		)
	}
	return right.type === 'ExplicitFallback' && left.reason === right.reason
}

function sameSlotSchedule(
	expected: MessageSlot | undefined,
	actual: MessageSlot | undefined,
) {
	return (
		expected !== undefined &&
		actual !== undefined &&
		sameMessageDefinition(expected, actual) &&
		expected.phase === actual.phase &&
		expected.dueAt === actual.dueAt &&
		expected.windowEndsAt === actual.windowEndsAt
	)
}

function sameMessageDefinition(
	definition: {
		readonly slotId: MessageSlotId
		readonly contentResourceId: ContentResourceId
		readonly presentation: {
			readonly bundleId: PresentationBundleId
			readonly subjectId: string
			readonly headlineId: string
			readonly openingId: string
			readonly ctaId: string
		}
	},
	slot:
		| {
				readonly slotId: MessageSlotId
				readonly contentResourceId: ContentResourceId
				readonly presentation: {
					readonly bundleId: PresentationBundleId
					readonly subjectId: string
					readonly headlineId: string
					readonly openingId: string
					readonly ctaId: string
				}
		  }
		| undefined,
) {
	return (
		slot !== undefined &&
		definition.slotId === slot.slotId &&
		definition.contentResourceId === slot.contentResourceId &&
		definition.presentation.bundleId === slot.presentation.bundleId &&
		definition.presentation.subjectId === slot.presentation.subjectId &&
		definition.presentation.headlineId === slot.presentation.headlineId &&
		definition.presentation.openingId === slot.presentation.openingId &&
		definition.presentation.ctaId === slot.presentation.ctaId
	)
}

function parsedString<Value extends string>(
	parser: (
		value: string,
	) => { readonly ok: true; readonly value: Value } | { readonly ok: false },
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

function decodeFailure(reason: string): JourneyRestorationResult {
	return { ok: false, error: { type: 'JourneyDecodeFailure', reason } }
}
