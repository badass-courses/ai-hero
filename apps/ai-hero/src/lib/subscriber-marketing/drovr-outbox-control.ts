import { Either, Schema } from 'effect'
import { activeContactStops } from './contact-stop-rule'
import { decodeHeldBatchContinuation } from './contact-sync-held-batch'
import { ProfileAck } from './contact-sync-profile-ack-schema'

/** One nullable JSON column; no bodies, error strings or timestamp rebasing. */
export const OUTBOX_CONTROL_MAX_ENCODED_BYTES = 256 * 1024
export const OUTBOX_CONTROL_REASON_MAX_CHARACTERS = 2048
const SafeCount = Schema.NonNegativeInt.pipe(
	Schema.filter(Number.isSafeInteger),
)
const EncodedBatch = Schema.String.pipe(
	Schema.filter((value) => {
		try {
			decodeHeldBatchContinuation(value)
			return true
		} catch {
			return false
		}
	}),
)
export const HeldColumnContinuation = Schema.Struct({
	v: Schema.Literal(1),
	encoded: Schema.optional(EncodedBatch),
	blocked: Schema.Boolean,
	reason: Schema.optional(
		Schema.String.pipe(Schema.maxLength(OUTBOX_CONTROL_REASON_MAX_CHARACTERS)),
	),
}).pipe(Schema.filter((value) => value.blocked || value.encoded !== undefined))
export const OutboxReplayProof = Schema.Struct({
	v: Schema.Literal(1),
	handoffs: SafeCount,
	waitingForStop: Schema.optional(Schema.Boolean),
	publicationId: Schema.optional(
		Schema.NonEmptyString.pipe(Schema.maxLength(128)),
	),
})
const ReceiptInstant = Schema.String.pipe(
	Schema.filter((value) => {
		const stamp = Date.parse(value)
		return Number.isFinite(stamp) && new Date(stamp).toISOString() === value
	}),
)
const ReceiptKey = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
const ReceiptText = (maximum: number) =>
	Schema.NonEmptyString.pipe(Schema.maxLength(maximum))
export const OwnerStopRejection = Schema.Struct({
	v: Schema.Literal(1),
	scope: Schema.Struct({
		key: ReceiptKey,
		target: ReceiptText(255),
		endpoint: Schema.Literal('events'),
		tenantId: Schema.Literal('org-aihero'),
		contactId: ReceiptText(255),
		journeyId: ReceiptText(100).pipe(
			Schema.filter((value) => value !== 'contact-directory'),
		),
		eventType: Schema.Literal(
			'contact.unsubscribed',
			'contact.bounced',
			'contact.complained',
			'purchase.recorded',
		),
		idempotencyKey: ReceiptText(500).pipe(Schema.startsWith('owner:')),
		occurredAt: ReceiptInstant,
	}),
	rejectionCode: Schema.Literal('cold-start-never-born'),
	httpStatus: Schema.Int.pipe(Schema.between(400, 499)),
	rejectedAttempt: Schema.Struct({
		runId: ReceiptText(128),
		requestId: Schema.String.pipe(
			Schema.pattern(
				/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
			),
		),
		stepKey: ReceiptKey,
		attempt: SafeCount,
	}),
	decidedAt: ReceiptInstant,
}).pipe(
	Schema.filter((value) => value.rejectedAttempt.stepKey === value.scope.key),
)
export interface OwnerStopRejection extends Schema.Schema.Type<
	typeof OwnerStopRejection
> {}

export const UnsubscribeSupersession = Schema.Struct({
	v: Schema.Literal(1),
	scope: Schema.Struct({
		key: ReceiptKey,
		target: ReceiptText(255),
		endpoint: Schema.Literal('events'),
		tenantId: ReceiptText(100),
		contactId: ReceiptText(255),
		journeyId: ReceiptText(100),
		eventType: Schema.Literal('contact.unsubscribed'),
		idempotencyKey: ReceiptText(500),
		occurredAt: ReceiptInstant,
	}),
	source: Schema.Struct({
		table: Schema.Literal('AI_ContactEvent'),
		eventType: Schema.Literal('contact.resubscribed'),
		contactId: ReceiptText(255),
		occurredAt: ReceiptInstant,
	}),
	decidedAt: ReceiptInstant,
}).pipe(
	Schema.filter(
		(value) =>
			value.source.contactId === value.scope.contactId &&
			!activeContactStops([
				{ kind: 'unsubscribed', at: value.scope.occurredAt },
				{ kind: 'resubscribed', at: value.source.occurredAt },
			]).unsubscribed,
	),
)
export interface UnsubscribeSupersession extends Schema.Schema.Type<
	typeof UnsubscribeSupersession
> {}

export const HeldContinuationEnvelope = Schema.Struct({
	v: Schema.Literal(1),
	continuation: Schema.optional(HeldColumnContinuation),
	replayProof: Schema.optional(OutboxReplayProof),
	ownerStopRejection: Schema.optional(OwnerStopRejection),
	unsubscribeSupersession: Schema.optional(UnsubscribeSupersession),
	profileAck: Schema.optional(ProfileAck),
}).pipe(
	Schema.filter(
		(value) =>
			Buffer.byteLength(JSON.stringify(value), 'utf8') <=
			OUTBOX_CONTROL_MAX_ENCODED_BYTES,
	),
)
export interface HeldContinuationEnvelope extends Schema.Schema.Type<
	typeof HeldContinuationEnvelope
> {}

export class OutboxControlError extends Schema.TaggedError<OutboxControlError>()(
	'OutboxControlError',
	{ reason: Schema.String },
) {
	get message() {
		return `OutboxControl: you used durable replay/held state, and it failed because ${this.reason}. Accepted: the apply-first heldContinuation JSON column and a v1 envelope of separately versioned continuation/replayProof/ownerStopRejection/unsubscribeSupersession/profileAck members within ${OUTBOX_CONTROL_MAX_ENCODED_BYTES} UTF-8 bytes. Fix: inspect the deploy request or retained state; never trim, acknowledge, reuse a wire body, or fall back to lastError. Debug: inspect the target/scoped key and saved SDK/publication receipts without exposing credentials or event bodies.`
	}
}
const decode = Schema.decodeUnknownEither(HeldContinuationEnvelope, {
	onExcessProperty: 'error',
})
export function readHeldContinuationEnvelope(
	value: unknown,
): HeldContinuationEnvelope | undefined {
	if (value === undefined || value === null) return undefined
	try {
		if (typeof value === 'string') {
			if (Buffer.byteLength(value, 'utf8') > OUTBOX_CONTROL_MAX_ENCODED_BYTES)
				throw new OutboxControlError({
					reason: 'the encoded operational envelope exceeds its byte bound',
				})
			value = JSON.parse(value)
		}
		const result = decode(value)
		if (Either.isLeft(result))
			throw new OutboxControlError({
				reason:
					'the operational version, member schema or encoded size is invalid',
			})
		return result.right
	} catch (error) {
		if (error instanceof OutboxControlError) throw error
		throw new OutboxControlError({
			reason: 'the operational envelope is not valid bounded JSON',
		})
	}
}
export function encodeHeldContinuationEnvelope(value: unknown): string {
	const parsed = readHeldContinuationEnvelope(value)
	if (!parsed)
		throw new OutboxControlError({
			reason:
				'a writer must provide an explicit versioned operational envelope',
		})
	return JSON.stringify(parsed)
}

export function missingHeldContinuationColumn(error: unknown): boolean {
	let current: unknown = error
	for (
		let depth = 0;
		depth < 6 && typeof current === 'object' && current !== null;
		depth++
	) {
		const code =
			('errno' in current && current.errno === 1054) ||
			('code' in current && current.code === 'ER_BAD_FIELD_ERROR')
		const text = `${'message' in current ? String(current.message) : ''} ${'sqlMessage' in current ? String(current.sqlMessage) : ''}`
		if (
			code &&
			/unknown column\s+['`"](?:[^'`"]*\.)?heldContinuation['`"]/i.test(text)
		)
			return true
		current = 'cause' in current ? current.cause : undefined
	}
	return false
}
let missingLogged = false
export async function warnHeldContinuationMissingOnce(): Promise<void> {
	if (missingLogged) return
	missingLogged = true
	try {
		await (
			await import('@/server/logger')
		).log.warn('drovr.outbox.held_column_unavailable', {
			column: 'heldContinuation',
			action:
				'apply the PlanetScale deploy request first; readers see no held state, writers refuse coordination',
		})
	} catch {
		/* A missing optional reader column and logging outage must not fail reads. */
	}
}
export async function writeHeldContinuationGuard<A>(
	write: () => Promise<A>,
): Promise<A> {
	try {
		return await write()
	} catch (error) {
		if (!missingHeldContinuationColumn(error)) throw error
		await warnHeldContinuationMissingOnce()
		throw new OutboxControlError({
			reason:
				'the heldContinuation column is missing; no coordination, acknowledgement or legacy diagnostic fallback is permitted',
		})
	}
}
export async function readWithHeldContinuationFallback<A>(
	read: () => Promise<A>,
	legacy: () => Promise<A>,
): Promise<A> {
	try {
		return await read()
	} catch (error) {
		if (!missingHeldContinuationColumn(error)) throw error
		await warnHeldContinuationMissingOnce()
		return legacy()
	}
}
