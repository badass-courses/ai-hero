import { Schema } from 'effect'

/** Same bounded legacy logical-membership budget as retry proof. The outer
 * envelope's 256 KiB UTF-8 limit still applies; never truncate references. */
export const PROFILE_ACK_MAX_REFERENCES = 1024
export const ACK_TOMBSTONE_MAX_AGE_MS = 400 * 24 * 60 * 60_000
export const ACK_TOMBSTONE_STATUS = 'ackTombstone'
export const ACK_TOMBSTONE_SOURCE = 'ackTombstone'
export const ACK_TOMBSTONE_ENDPOINT = 'control'
export const ACK_TOMBSTONE_EVENT_TYPE = 'profile.ack.tombstone'
export const AckTombstoneBody = Schema.Struct({
	control: Schema.Literal(ACK_TOMBSTONE_STATUS),
	v: Schema.Literal(1),
})
export const ACK_TOMBSTONE_BODY = Object.freeze({
	control: ACK_TOMBSTONE_STATUS,
	v: 1 as const,
})
const Key = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
const Text = Schema.NonEmptyString.pipe(Schema.maxLength(255))
const Version = Schema.NonNegativeInt.pipe(
	Schema.filter((value) => Number.isSafeInteger(value) && value > 0),
)
const Instant = Schema.String.pipe(
	Schema.filter((value) => {
		const stamp = Date.parse(value)
		return Number.isFinite(stamp) && new Date(stamp).toISOString() === value
	}),
)
export const ProfileAckRequest = Schema.Union(
	Schema.Struct({ kind: Schema.Literal('delta') }),
	Schema.Struct({
		kind: Schema.Literal('restate'),
		period: Schema.String.pipe(Schema.pattern(/^\d{4}-(0[1-9]|1[0-2])$/)),
	}),
)
const ProfileAckScope = {
	target: Text,
	endpoint: Schema.Literal('events'),
	tenantId: Schema.Literal('org-aihero'),
	contactId: Text,
	journeyId: Schema.Literal('contact-directory'),
	profileVersion: Version,
	coordinatorKey: Key,
}
/** Logical key only, never sufficient to claim a frozen membership/proof. */
export const ProfileAckIdentity = Schema.Struct({
	...ProfileAckScope,
	request: ProfileAckRequest,
})
export interface ProfileAckIdentity extends Schema.Schema.Type<
	typeof ProfileAckIdentity
> {}
export const ProfileAckReference = Schema.Struct({
	...ProfileAckScope,
	requestId: Key,
	request: ProfileAckRequest,
})
export interface ProfileAckReference extends Schema.Schema.Type<
	typeof ProfileAckReference
> {}
export const ProfileAckMember = Schema.Struct({
	key: Key,
	eventType: Schema.Literal('contact.profile.updated', 'contact.links.issued'),
	bodyHash: Key,
	firstFailedAt: Instant,
})
export interface ProfileAckMember extends Schema.Schema.Type<
	typeof ProfileAckMember
> {}
const Members = Schema.Array(ProfileAckMember).pipe(
	Schema.minItems(1),
	Schema.maxItems(PROFILE_ACK_MAX_REFERENCES),
	Schema.filter((members) =>
		members.every(
			(member, index) => index === 0 || members[index - 1]!.key < member.key,
		),
	),
)
export const ProfileAck = Schema.Union(
	Schema.Struct({
		v: Schema.Literal(1),
		role: Schema.Literal('coordinator'),
		ref: ProfileAckReference,
		registeredAt: Instant,
		members: Members,
		completion: Schema.optional(
			Schema.Struct({
				proofId: Key,
				/** Frozen delivered-profile occurredAt; ONLY this drives age. */
				confirmationClock: Instant,
				/** First complete delivery-receipt proof time; audit only. */
				provedAt: Instant,
				disposition: Schema.Literal('acknowledged', 'version-superseded'),
			}),
		),
	}).pipe(
		Schema.filter(
			(value) =>
				value.members.filter(
					(member) => member.eventType === 'contact.profile.updated',
				).length === 1 &&
				value.members.some(
					(member) =>
						member.key === value.ref.coordinatorKey &&
						member.eventType === 'contact.profile.updated',
				),
		),
	),
	Schema.Struct({
		v: Schema.Literal(1),
		role: Schema.Literal('member'),
		ref: ProfileAckReference,
	}),
	Schema.Struct({
		v: Schema.Literal(1),
		role: Schema.Literal('tombstone'),
		ref: ProfileAckReference,
		createdAt: Instant,
		expiresAt: Instant,
		/** Monotonic purge fence; never clears or extends the first expiry. */
		evidenceExpired: Schema.optional(Schema.Literal(true)),
		reason: Schema.Literal(
			'incomplete-proof',
			'expired-evidence',
			'ack-write-failed',
		),
	}).pipe(
		Schema.filter(
			(value) =>
				Date.parse(value.expiresAt) - Date.parse(value.createdAt) ===
				ACK_TOMBSTONE_MAX_AGE_MS,
		),
	),
)
export type ProfileAck = Schema.Schema.Type<typeof ProfileAck>
export type ProfileAckCoordinator = Extract<ProfileAck, { role: 'coordinator' }>
export type ProfileAckTombstone = Extract<ProfileAck, { role: 'tombstone' }>

/** A result, deliberately not an Error. Purged evidence cannot authorize
 * history reconstruction, a timestamp refresh or an Inngest retry storm. */
export const AckEvidenceExpired = Schema.TaggedStruct('AckEvidenceExpired', {
	v: Schema.Literal(1),
	target: Text,
	contactId: Text,
	profileVersion: Version,
	requestId: Schema.optional(Key),
})
export interface AckEvidenceExpired extends Schema.Schema.Type<
	typeof AckEvidenceExpired
> {}
