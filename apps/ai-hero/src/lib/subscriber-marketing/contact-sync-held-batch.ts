import { Either, Schema } from 'effect'

/** Logical references, not the HTTP rate limit or SDK operation budget. */
export const HELD_BATCH_MAX_REFERENCES = 128
/** Leaves space in the diagnostic TEXT for its envelope and original reason. */
export const HELD_BATCH_MAX_ENCODED_BYTES = 48 * 1024
/** Expiry is an operator signal, NEVER permission to delete evidence. */
export const HELD_BATCH_PIN_MAX_AGE_MS = 30 * 24 * 60 * 60_000

const OutboxKey = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
const Identifier = Schema.NonEmptyString.pipe(Schema.maxLength(256))
const OriginalClock = Schema.String.pipe(
	Schema.filter((value) => {
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
			return false
		const instant = Date.parse(value)
		return Number.isFinite(instant) && new Date(instant).toISOString() === value
	}),
)
const WholeCount = Schema.NonNegativeInt.pipe(
	Schema.filter(Number.isSafeInteger),
)
const PositiveCount = WholeCount.pipe(Schema.filter((value) => value > 0))
const UnfinishedReference = Schema.Struct({
	key: OutboxKey,
	phase: Schema.Literal('pending', 'carry'),
	reason: Schema.Literal('event-not-live', 'cold-start-unhandled'),
})
const RetainedReference = Schema.Struct({
	key: OutboxKey,
	/** Bookkeeping only; the row's current disposition remains authoritative. */
	phase: Schema.Literal('retained'),
})
const Reference = Schema.Union(UnfinishedReference, RetainedReference)

/**
 * The hash references the existing target/endpoint/tenant/contact/journey/key
 * identity, not a bare wire key. Replay must load and validate those rows in
 * this target; it must not recreate a body or infer acceptance from this record.
 *
 * This is durable state in a diagnostic column: a one-way compatibility
 * boundary until the post-wave dedicated-column migration exists.
 */
export const HeldBatchContinuation = Schema.Struct({
	v: Schema.Literal(1),
	release: Schema.Union(
		Schema.Struct({ state: Schema.Literal('held') }),
		Schema.Struct({
			state: Schema.Literal('released'),
			id: Schema.String.pipe(
				Schema.pattern(
					/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
				),
			),
		}),
	),
	target: Identifier,
	anchorKey: OutboxKey,
	source: Schema.Literal(
		'live',
		'contact-profile-sync',
		'contact-profile-restate',
		'kit-directory-ingest',
		'contact-sync-backfill',
		'evergreen-pitch-backfill',
	),
	class: Schema.Literal('live', 'delta', 'restate', 'ingest', 'backfill'),
	originalClock: OriginalClock,
	/** First hold's operational timestamp, never a receiver/birth clock. */
	parkedAt: OriginalClock,
	completion: Schema.Union(
		Schema.Struct({ state: Schema.Literal('unfinished') }),
		Schema.Struct({
			state: Schema.Literal('completed'),
			at: OriginalClock,
			reason: Schema.Literal('delivered', 'terminal-rejected', 'abandoned'),
		}),
	),
	attempt: PositiveCount,
	rejectedCarry: WholeCount,
	acknowledge: Schema.optional(
		Schema.Struct({
			contactId: Identifier,
			profileVersion: PositiveCount,
		}),
	),
	members: Schema.Array(Reference).pipe(
		Schema.maxItems(HELD_BATCH_MAX_REFERENCES),
	),
}).pipe(
	Schema.filter((value) => {
		const expectedClass = {
			live: 'live',
			'contact-profile-sync': 'delta',
			'contact-profile-restate': 'restate',
			'kit-directory-ingest': 'ingest',
			'contact-sync-backfill': 'backfill',
			'evergreen-pitch-backfill': 'backfill',
		}[value.source]
		return (
			value.class === expectedClass &&
			!(value.class === 'live' && value.acknowledge !== undefined) &&
			value.members.some((member) => member.key === value.anchorKey) &&
			value.members.some(
				(member) => member.phase === 'pending' || member.phase === 'carry',
			) &&
			new Set(value.members.map((member) => member.key)).size ===
				value.members.length
		)
	}),
)
export interface HeldBatchContinuation extends Schema.Schema.Type<
	typeof HeldBatchContinuation
> {}

export class HeldBatchContinuationError extends Schema.TaggedError<HeldBatchContinuationError>()(
	'HeldBatchContinuationError',
	{ reason: Schema.String },
) {
	get message() {
		return `HeldBatchContinuation: you resumed held work, and it failed because ${this.reason}. Accepted: v1 scoped references within ${HELD_BATCH_MAX_REFERENCES} members and ${HELD_BATCH_MAX_ENCODED_BYTES} UTF-8 bytes, with the original clock and matching source/class. Fix: keep the anchor held, inspect the original scope and repair it before explicit operator release; never truncate or rebase it. Debug: inspect the anchor's durable diagnostic state; no HTTP attempt or acknowledgement is authorized.`
	}
}

const decodeValue = Schema.decodeUnknownEither(HeldBatchContinuation, {
	onExcessProperty: 'error',
})

function validateHeldBatch(value: unknown): HeldBatchContinuation {
	const decoded = decodeValue(value)
	if (Either.isLeft(decoded))
		throw new HeldBatchContinuationError({
			reason:
				'the version, reference scope, count or continuation fields are invalid',
		})
	return decoded.right
}

function checkEncodedBytes(value: string): void {
	if (Buffer.byteLength(value, 'utf8') > HELD_BATCH_MAX_ENCODED_BYTES)
		throw new HeldBatchContinuationError({
			reason: 'the encoded continuation exceeds the byte cap',
		})
}

/** Throws a literal-prompt error; the storage adapter must leave the anchor held. */
export function decodeHeldBatchContinuation(
	value: string,
): HeldBatchContinuation {
	checkEncodedBytes(value)
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		throw new HeldBatchContinuationError({
			reason: 'the stored continuation is not valid JSON',
		})
	}
	return validateHeldBatch(parsed)
}

/** Validation precedes serialization; unknown properties (including bodies) fail. */
export function encodeHeldBatchContinuation(value: unknown): string {
	const encoded = JSON.stringify(validateHeldBatch(value))
	checkEncodedBytes(encoded)
	return encoded
}
