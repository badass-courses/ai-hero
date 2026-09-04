declare const evergreenOfferBrand: unique symbol

type Brand<Value, Name extends string> = Value & {
	readonly [evergreenOfferBrand]: Name
}

export type ContactId = Brand<string, 'ContactId'>
export type ContentResourceId = Brand<string, 'ContentResourceId'>
export type CouponId = Brand<string, 'CouponId'>
export type EntryFactId = Brand<string, 'EntryFactId'>
export type IntentKey = Brand<string, 'IntentKey'>
export type IsoInstant = Brand<string, 'IsoInstant'>
export type JourneyId = Brand<string, 'JourneyId'>
export type MessageSlotId = Brand<string, 'MessageSlotId'>
export type PresentationBundleId = Brand<string, 'PresentationBundleId'>
export type StimulusId = Brand<string, 'StimulusId'>
export type VerifiedUserId = Brand<string, 'VerifiedUserId'>
export type WakeId = Brand<string, 'WakeId'>
export type IanaTimeZone = Brand<string, 'IanaTimeZone'>

export type PrimitiveParseError = {
	readonly type: 'PrimitiveParseError'
	readonly field: string
	readonly value: string
	readonly reason:
		| 'blank'
		| 'invalid-iso-instant'
		| 'invalid-iana-time-zone'
		| 'invalid-journey-id'
}

export type ParseResult<Value> =
	| { readonly ok: true; readonly value: Value }
	| { readonly ok: false; readonly error: PrimitiveParseError }

function parseNonBlankBrand<Name extends string>(args: {
	field: string
	value: string
}): ParseResult<Brand<string, Name>> {
	if (args.value.trim().length === 0) {
		return {
			ok: false,
			error: {
				type: 'PrimitiveParseError',
				field: args.field,
				value: args.value,
				reason: 'blank',
			},
		}
	}

	// SAFETY: the value is non-blank and the constructor is the only brand edge.
	return { ok: true, value: args.value.trim() as Brand<string, Name> }
}

export function parseContactId(value: string) {
	return parseNonBlankBrand<'ContactId'>({ field: 'contactId', value })
}

export function parseContentResourceId(value: string) {
	return parseNonBlankBrand<'ContentResourceId'>({
		field: 'contentResourceId',
		value,
	})
}

export function parseCouponId(value: string) {
	return parseNonBlankBrand<'CouponId'>({ field: 'couponId', value })
}

export function parseEntryFactId(value: string) {
	return parseNonBlankBrand<'EntryFactId'>({ field: 'entryFactId', value })
}

export function parseIntentKey(value: string) {
	return parseNonBlankBrand<'IntentKey'>({ field: 'intentKey', value })
}

export function parseJourneyId(value: string): ParseResult<JourneyId> {
	const parsed = parseNonBlankBrand<'JourneyId'>({ field: 'journeyId', value })
	if (!parsed.ok) return parsed
	if (!parsed.value.startsWith('evergreen-offer:')) {
		return {
			ok: false,
			error: {
				type: 'PrimitiveParseError',
				field: 'journeyId',
				value,
				reason: 'invalid-journey-id',
			},
		}
	}
	return parsed
}

export function parseMessageSlotId(value: string) {
	return parseNonBlankBrand<'MessageSlotId'>({ field: 'messageSlotId', value })
}

export function parsePresentationBundleId(value: string) {
	return parseNonBlankBrand<'PresentationBundleId'>({
		field: 'presentationBundleId',
		value,
	})
}

export function parseStimulusId(value: string) {
	return parseNonBlankBrand<'StimulusId'>({ field: 'stimulusId', value })
}

export function parseVerifiedUserId(value: string) {
	return parseNonBlankBrand<'VerifiedUserId'>({
		field: 'verifiedUserId',
		value,
	})
}

export function parseWakeId(value: string) {
	return parseNonBlankBrand<'WakeId'>({ field: 'wakeId', value })
}

export function parseIsoInstant(value: string): ParseResult<IsoInstant> {
	const candidate = value.trim()
	if (candidate.length === 0) {
		return {
			ok: false,
			error: {
				type: 'PrimitiveParseError',
				field: 'instant',
				value,
				reason: 'blank',
			},
		}
	}
	const explicitIsoInstant =
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
	const timestamp = explicitIsoInstant.test(candidate)
		? Date.parse(candidate)
		: Number.NaN
	if (!Number.isFinite(timestamp)) {
		return {
			ok: false,
			error: {
				type: 'PrimitiveParseError',
				field: 'instant',
				value,
				reason: 'invalid-iso-instant',
			},
		}
	}

	// SAFETY: Date.parse accepted the instant and normalization removes offsets.
	return { ok: true, value: new Date(timestamp).toISOString() as IsoInstant }
}

export function parseIanaTimeZone(value: string): ParseResult<IanaTimeZone> {
	if (value.trim().length === 0) {
		return {
			ok: false,
			error: {
				type: 'PrimitiveParseError',
				field: 'timeZone',
				value,
				reason: 'blank',
			},
		}
	}
	const candidate = value.trim()
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format()
	} catch {
		return {
			ok: false,
			error: {
				type: 'PrimitiveParseError',
				field: 'timeZone',
				value,
				reason: 'invalid-iana-time-zone',
			},
		}
	}

	// SAFETY: Intl.DateTimeFormat accepted the IANA time-zone identifier.
	return { ok: true, value: candidate as IanaTimeZone }
}

export function deriveJourneyId(entryFactId: EntryFactId): JourneyId {
	// SAFETY: a non-blank EntryFactId always produces one deterministic JourneyId.
	return `evergreen-offer:${entryFactId}` as JourneyId
}

export function messageIntentKey(args: {
	journeyId: JourneyId
	contentResourceId: ContentResourceId
}): IntentKey {
	// SAFETY: both branded parts are non-blank and the prefix fixes key meaning.
	return `${args.journeyId}:message:${args.contentResourceId}` as IntentKey
}

export function couponIntentKey(journeyId: JourneyId): IntentKey {
	// SAFETY: the branded journey identity fixes one coupon semantic key.
	return `${journeyId}:coupon.issue` as IntentKey
}

export function shadowIntentKey(journeyId: JourneyId): IntentKey {
	// SAFETY: the branded journey identity fixes one audience semantic key.
	return `${journeyId}:shadow.enter` as IntentKey
}

export function couponBindingIntentKey(args: {
	journeyId: JourneyId
	verifiedUserId: VerifiedUserId
}): IntentKey {
	// SAFETY: both branded parts are non-blank and the prefix fixes key meaning.
	return `${args.journeyId}:coupon.bind:${args.verifiedUserId}` as IntentKey
}

export function scheduleWakeId(args: {
	journeyId: JourneyId
	semanticStepId: string
}): WakeId {
	const step = args.semanticStepId.trim()
	if (step.length === 0) {
		throw new Error('semanticStepId must not be blank')
	}
	// SAFETY: the validated step and branded journey produce one wake identity.
	return `${args.journeyId}:wake:${step}` as WakeId
}
