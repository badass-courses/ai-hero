import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, eq, inArray } from 'drizzle-orm'
import { Either, Schema } from 'effect'
import {
	deliverEventNameFor,
	type DrovrDeliverEnvelope,
} from '@/inngest/events/drovr'
import { ackTombstoneKey, readAckTombstone } from './contact-sync-ack-tombstone'
import { guardProfileAckWorkerAdmission } from './contact-sync-profile-ack-admission'
import {
	assertProfileAckRetainedMember,
	evaluateProfileAckCompletion,
	expiredProfileAck,
	ProfileAckConflict,
} from './contact-sync-profile-ack'
import { settleAndCompleteProfileAck } from './contact-sync-profile-ack-persistence'
import {
	prepareProfileAckRegistration,
	readProfileAckRegistrationEpoch,
} from './contact-sync-profile-ack-registration-drizzle'
import type { ProfileAckProducerPorts } from './contact-sync-profile-ack-registration'
import { ProfileAckReference } from './contact-sync-profile-ack-schema'
import type { AckEvidenceExpired } from './contact-sync-profile-ack-schema'
import {
	readHeldContinuationEnvelope,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'
import { fromStored } from './drovr-outbox-drizzle'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const decode = Schema.decodeUnknownEither(ProfileAckReference, {
	onExcessProperty: 'error',
})
const identity = (ref: ProfileAckReference) =>
	JSON.stringify([
		ref.target,
		ref.contactId,
		ref.profileVersion,
		ref.coordinatorKey,
		ref.requestId,
		ref.request.kind,
		ref.request.kind === 'restate' ? ref.request.period : null,
	])
type Database = typeof import('@/db').db
type Publication = DrovrDeliverEnvelope & { id: string }

/** Producer adapters have no current-snapshot read in publication/completion.
 * A frozen SDK value only addresses retained original native rows. Missing
 * evidence is terminal; native replay independently keeps surviving debt. */
export function createProfileAckProducerPorts(args: {
	database: unknown
	target: string | undefined
	enabled: () => Promise<boolean>
	send: (events: Publication[]) => Promise<unknown>
	onExpired?: (value: AckEvidenceExpired) => Promise<void>
}): ProfileAckProducerPorts {
	const db = args.database as Pick<Database, 'select'>
	const validate = (value: ProfileAckReference) => {
		const decoded = decode(value)
		if (
			Either.isLeft(decoded) ||
			!args.target ||
			decoded.right.target !== args.target
		)
			throw new ProfileAckConflict(
				'the producer reference is malformed or belongs to another deployment target',
			)
		return decoded.right
	}
	const expired = async (ref: ProfileAckReference) => {
		const result = expiredProfileAck(ref)
		try {
			await args.onExpired?.(result)
		} catch {
			/* Logging cannot turn expiry into an SDK retry. */
		}
		return result
	}
	const read = async (ref: ProfileAckReference, keys: readonly string[]) => {
		const rows: (typeof drovrOutbox.$inferSelect)[] = []
		for (let offset = 0; offset < keys.length; offset += 128)
			rows.push(
				...(await writeHeldContinuationGuard(() =>
					db
						.select()
						.from(drovrOutbox)
						.where(
							and(
								eq(drovrOutbox.target, ref.target),
								inArray(
									drovrOutbox.dedupeKey,
									keys.slice(offset, offset + 128),
								),
							),
						),
				)),
			)
		if (
			new Set(rows.map((row) => row.dedupeKey)).size !== rows.length ||
			rows.some(
				(row) => row.target !== ref.target || !keys.includes(row.dedupeKey),
			)
		)
			throw new ProfileAckConflict(
				'the producer reader returned duplicate or foreign native evidence',
			)
		return rows
	}
	return {
		registrationEpoch: () => readProfileAckRegistrationEpoch(args.database),
		prepare: (input) => prepareProfileAckRegistration({ ...args, input }),
		admit: async (value) => {
			const ref = validate(value)
			const denied = await guardProfileAckWorkerAdmission({
				database: args.database,
				target: ref.target,
				ref,
				events: [],
				ackOnly: true,
			})
			return denied ? expired(ref) : undefined
		},
		publish: async (value) => {
			const ref = validate(value)
			const roots = await read(ref, [ref.coordinatorKey, ackTombstoneKey(ref)])
			const carrier = roots.find((row) => row.dedupeKey === ref.coordinatorKey)
			const markerRow = roots.find(
				(row) => row.dedupeKey === ackTombstoneKey(ref),
			)
			const marker = markerRow ? readAckTombstone(markerRow) : undefined
			if (marker && identity(marker.ref) !== identity(ref))
				throw new ProfileAckConflict(
					'the producer tombstone retains another first request',
				)
			const state = carrier
				? readHeldContinuationEnvelope(carrier.heldContinuation)?.profileAck
				: undefined
			if (
				state &&
				(state.role !== 'coordinator' || identity(state.ref) !== identity(ref))
			)
				throw new ProfileAckConflict(
					'the producer coordinator retains another first request',
				)
			if (
				!state ||
				state.role !== 'coordinator' ||
				marker?.evidenceExpired ||
				marker?.reason === 'expired-evidence'
			)
				return expired(ref)
			const stored = await read(
				ref,
				state.members.map((member) => member.key),
			)
			if (stored.length !== state.members.length) return expired(ref)
			const rows = stored.map(fromStored)
			for (const row of rows) assertProfileAckRetainedMember(state, row)
			const evaluation = evaluateProfileAckCompletion(state, rows)
			if (evaluation._tag === 'AckEvidenceExpired') return expired(ref)
			if (
				evaluation._tag === 'ProfileAckWaiting' &&
				evaluation.reason === 'blocked'
			)
				return { _tag: 'ProfileAckPublicationRetained', reason: 'native-gate' }
			// Healthy waits, rejected/held debt and already-delivered members do
			// not gain a new publication/release from an old parent SDK effect.
			if (
				rows.some(
					(row) =>
						row.status !== 'pending' &&
						row.status !== 'deferred' &&
						row.status !== 'delivered',
				)
			)
				return { _tag: 'ProfileAckPublicationRetained', reason: 'native-gate' }
			const events = rows
				.filter((row) => row.status === 'pending' || row.status === 'deferred')
				.sort(
					(a, b) =>
						Number(b.eventType === 'contact.profile.updated') -
							Number(a.eventType === 'contact.profile.updated') ||
						a.dedupeKey.localeCompare(b.dedupeKey),
				)
				.map((row) => row.body as DrovrShadowEvent)
			if (!events.length) return { _tag: 'ProfileAckPublicationRetained', reason: 'already-delivered' }
			// Inside the actual publication SDK effect, immediately before send.
			const denied = await guardProfileAckWorkerAdmission({
				database: args.database,
				target: ref.target,
				ref,
				events,
			})
			if (denied) return expired(ref)
			const source =
				ref.request.kind === 'restate'
					? 'contact-profile-restate'
					: 'contact-profile-sync'
			await args.send([
				{
					id: `sync-frozen:${ref.requestId}`,
					name: deliverEventNameFor(source),
					data: {
						source,
						events,
						profileAckRef: ref,
						profileAckNativeDebt: true,
					},
				},
			])
			return { _tag: 'ProfileAckPublished' }
		},
		complete: async (value) => {
			const ref = validate(value)
			const result = await settleAndCompleteProfileAck({
				database: args.database,
				ref,
				enabled: args.enabled,
				settledKeys: [ref.coordinatorKey],
				settle: async () => 0,
			})
			if (result._tag === 'ProfileAckDisabled')
				return { _tag: 'ProfileAckAwaitingProof' }
			const evaluation = result.evaluation
			if (evaluation._tag === 'AckEvidenceExpired') return expired(ref)
			if (evaluation._tag === 'ProfileAckReceiverRefused')
				return { _tag: 'ProfileAckReceiverRefused' }
			if (evaluation._tag !== 'ProfileAckReady')
				return { _tag: 'ProfileAckAwaitingProof' }
			if (
				!Number.isInteger(result.confirmedLinks) ||
				result.confirmedLinks! < 0 ||
				!result.disposition
			)
				throw new ProfileAckConflict(
					'the completion adapter omitted reporting of its actually proved original membership',
				)
			return {
				_tag: 'ProfileAckConfirmed',
				ref,
				links: result.confirmedLinks!,
				confirmationClock: evaluation.proof.confirmationClock,
				disposition: result.disposition,
			}
		},
	}
}
