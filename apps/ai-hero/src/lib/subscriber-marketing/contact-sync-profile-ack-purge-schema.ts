import { Schema } from 'effect'

export const ProfileAckPurgeRefused = Schema.TaggedStruct('PurgeRefused', {
	v: Schema.Literal(1),
	reason: Schema.Literal('profile-ack-protection-flag-off'),
	protectedRows: Schema.Number.pipe(Schema.int(), Schema.positive()),
	candidateRows: Schema.Number.pipe(Schema.int(), Schema.positive()),
})
export interface ProfileAckPurgeRefused extends Schema.Schema.Type<
	typeof ProfileAckPurgeRefused
> {}
export const PROFILE_ACK_PURGE_REFUSED_SIGNAL = 'drovr.outbox.purge_refused'
export function profileAckPurgeRefusalPrompt(result: ProfileAckPurgeRefused) {
	return `PurgeRefused: you requested delivered-evidence purge, and it failed because profile-ack-protection-flag-off protects ${result.protectedRows} of ${result.candidateRows} candidate rows. Accepted: one bounded whole-tick refusal with no deletions, pins or OFF tombstone writes. Fix: restore/re-enable the profile ACK app flag or explicitly drain the existing requests; wait for the next scheduled tick, never hot-retry. Debug: alert on drovr.outbox.purge_refused persisting more than 24h; counts only, no contact or row ids.`
}
