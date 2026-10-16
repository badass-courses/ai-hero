import {
	HELD_BATCH_MAX_REFERENCES,
	HeldBatchContinuationError,
} from './contact-sync-held-batch'
import { drovrOutboxDedupeKey, type DrovrOutboxRow } from './drovr-outbox'
import type { RetryData } from './contact-sync-retry-route'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'
import {
	supersededUnsubscribeAt,
	supersedingResubscribeAt,
} from './drovr-unsubscribe-supersession'

export const RETRY_PROOF_MAX_REFERENCES = 1024
/** Legacy healthy cohorts may exceed the HELD codec cap, but never read an
 * unbounded list or silently truncate a proof. Holds still cap at 128 refs. */
export async function retryProofRowsLive(
	target: string,
	keys: readonly string[],
): Promise<DrovrOutboxRow[]> {
	if (keys.length > RETRY_PROOF_MAX_REFERENCES)
		throw new HeldBatchContinuationError({
			reason:
				'the frozen logical proof exceeds its bounded legacy reference budget; no acknowledgement is authorized',
		})
	// This reader authorizes an ACK: each chunk must read coordination
	// storage strictly, not merely probe once then use a tolerant fallback.
	const { heldBatchRowsLive } =
		await import('./contact-sync-held-batch-drizzle')
	const rows: DrovrOutboxRow[] = []
	for (let at = 0; at < keys.length; at += HELD_BATCH_MAX_REFERENCES)
		rows.push(
			...(await heldBatchRowsLive(
				target,
				keys.slice(at, at + HELD_BATCH_MAX_REFERENCES),
				{ requireControl: true },
			)),
		)
	return rows
}

export type RetryAcknowledgementProof =
	| { proved: true; rejected: number; additionalAuthority?: string }
	| { proved: false; reason: string; ackEvidenceExpired?: import('./contact-sync-profile-ack-schema').AckEvidenceExpired }
const family = new Set([
	'contact.profile.updated',
	'contact.links.issued',
	'contact.offer.issued',
])
const normalized = (row: DrovrOutboxRow): DrovrShadowEvent | undefined => {
	if (
		row.endpoint !== 'events' ||
		row.needsFanOut ||
		row.queueMetadataInvalid ||
		!row.body ||
		typeof row.body !== 'object'
	)
		return undefined
	const event = row.body as DrovrShadowEvent
	return row.dedupeKey === drovrOutboxDedupeKey(row.target, row) &&
		event.tenantId === row.tenantId &&
		event.contactId === row.contactId &&
		event.journeyId === row.journeyId &&
		event.idempotencyKey === row.idempotencyKey &&
		event.type === row.eventType &&
		event.occurredAt === row.occurredAt &&
		Number.isFinite(Date.parse(event.occurredAt)) &&
		Number.isFinite(Date.parse(row.firstFailedAt))
		? event
		: undefined
}
const terminal = (row: DrovrOutboxRow): boolean => {
	if (row.heldBatchBlocked) return false
	if (row.status === 'delivered' || row.status === 'rejected') return true
	const lift = supersededUnsubscribeAt(row)
	return (
		row.status === 'superseded' &&
		!!lift &&
		!!supersedingResubscribeAt(row, lift)
	)
}

/** No body reconstruction, version inference or metadata-only acceptance.
 * Admission permits a profile that is still in the frozen wire membership;
 * terminal proof requires a delivered matching profile and all members done. */
export async function proveRetryAcknowledgement(args: {
	data: RetryData
	target: string
	phase: 'admission' | 'terminal'
	rows: (
		target: string,
		keys: readonly string[],
	) => Promise<readonly DrovrOutboxRow[]>
}): Promise<RetryAcknowledgementProof> {
	const ack = args.data.acknowledge
	if (
		ack &&
		(!ack.contactId ||
			!Number.isSafeInteger(ack.profileVersion) ||
			ack.profileVersion < 1)
	)
		return {
			proved: false,
			reason: 'the acknowledgement identity/version is invalid',
		}
	const keys = args.data.ownedKeys ?? []
	if (
		!ack &&
		((!keys.length && !args.data.items.length && !args.data.carry?.length) ||
			args.phase === 'admission')
	)
		return { proved: true, rejected: 0 }
	if (
		!keys.length ||
		keys.length > RETRY_PROOF_MAX_REFERENCES ||
		new Set(keys).size !== keys.length
	)
		return {
			proved: false,
			reason:
				'the logical acknowledgement has no unique frozen ownership membership',
		}
	const rows = await args.rows(args.target, keys)
	if (
		rows.length !== keys.length ||
		new Set(rows.map((row) => row.dedupeKey)).size !== keys.length ||
		rows.some(
			(row) => row.target !== args.target || !keys.includes(row.dedupeKey),
		)
	)
		return {
			proved: false,
			reason: 'one or more frozen logical members have no scoped durable row',
		}
	let profile: DrovrOutboxRow | undefined
	let rejected = 0
	for (const row of rows) {
		const event = normalized(row)
		if (!event)
			return {
				proved: false,
				reason:
					'a first stored body or clock does not match its scoped ownership row',
			}
		if (
			ack &&
			family.has(event.type) &&
			(event.tenantId !== 'org-aihero' ||
				event.contactId !== ack.contactId ||
				!event.payload ||
				!('profileVersion' in event.payload) ||
				event.payload.profileVersion !== ack.profileVersion)
		)
			return {
				proved: false,
				reason:
					'the acknowledgement does not match the first stored authority contact/version',
			}
		if (event.type === 'contact.profile.updated') profile = row
		if (row.status === 'rejected') rejected += 1
		if (args.phase === 'terminal' && !terminal(row))
			return {
				proved: false,
				reason:
					'a logical member lacks fresh receiver acceptance or valid local unsubscribe closure',
			}
	}
	if (!ack || (args.phase === 'terminal' && rejected > 0))
		return { proved: true, rejected }
	if (profile)
		return !profile.heldBatchBlocked &&
			(args.phase === 'admission'
				? ['pending', 'deferred', 'delivered'].includes(profile.status)
				: profile.status === 'delivered')
			? { proved: true, rejected }
			: {
					proved: false,
					reason:
						'the profile itself has no usable current ownership or receiver-acceptance receipt',
				}
	// Old retries sometimes carry only the links refused after profile success.
	// Load that exact known authority key, never a new current snapshot.
	const key = drovrOutboxDedupeKey(args.target, {
		endpoint: 'events',
		tenantId: 'org-aihero',
		contactId: ack.contactId,
		journeyId: 'contact-directory',
		idempotencyKey: `profile:${ack.contactId}:${ack.profileVersion}`,
	})
	const prior = (await args.rows(args.target, [key]))[0]
	const event = prior && normalized(prior)
	if (
		!prior ||
		prior.target !== args.target ||
		prior.dedupeKey !== key ||
		prior.status !== 'delivered' ||
		prior.heldBatchBlocked ||
		event?.type !== 'contact.profile.updated' ||
		!event.payload ||
		!('profileVersion' in event.payload) ||
		event.payload.profileVersion !== ack.profileVersion
	)
		return {
			proved: false,
			reason:
				'the omitted profile has no matching first-body receiver-acceptance receipt; an offer/link cannot acknowledge it',
		}
	return { proved: true, rejected, additionalAuthority: key }
}
