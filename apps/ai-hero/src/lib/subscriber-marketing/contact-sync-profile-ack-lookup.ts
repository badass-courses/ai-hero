import { contactProfileVersion } from '@/db/contact-sync-schema'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import { ackTombstoneKey, readAckTombstone } from './contact-sync-ack-tombstone'
import { ProfileAckConflict } from './contact-sync-profile-ack'
import type { ProfileAckReference } from './contact-sync-profile-ack-schema'
import {
	readHeldContinuationEnvelope,
	readWithHeldContinuationFallback,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'
import { drovrOutboxDedupeKey } from './drovr-outbox'
import { assertOutboxWireRow } from './drovr-outbox-wire-status'

const LIMIT = 1026
const sameRequest = (
	a: ProfileAckReference['request'],
	b: ProfileAckReference['request'],
) =>
	a.kind === b.kind &&
	(a.kind !== 'restate' || (b.kind === 'restate' && a.period === b.period))
function coordinatorKey(
	ref: Pick<
		ProfileAckReference,
		'target' | 'contactId' | 'profileVersion' | 'request'
	>,
) {
	return drovrOutboxDedupeKey(ref.target, {
		endpoint: 'events',
		tenantId: 'org-aihero',
		contactId: ref.contactId,
		journeyId: 'contact-directory',
		idempotencyKey: `profile:${ref.contactId}:${ref.profileVersion}${ref.request.kind === 'restate' ? `:restate:${ref.request.period}` : ''}`,
	})
}
function parsedBody(value: unknown): unknown {
	try {
		return typeof value === 'string' ? JSON.parse(value) : value
	} catch {
		throw new ProfileAckConflict(
			'the retained native body cannot be decoded; no replacement or absence may be inferred',
		)
	}
}
const identity = (ref: ProfileAckReference) =>
	JSON.stringify([
		ref.target,
		ref.contactId,
		ref.profileVersion,
		ref.coordinatorKey,
		ref.requestId,
		ref.request,
	])

type Database = typeof import('@/db').db

/** No request is manufactured here. A computed native/tombstone key is only
 * a lookup address; only a strictly decoded retained reference is returned.
 * Caller holds the contact-version lock before taking these native locks. */
export async function lookupProfileAckReferences(args: {
	database: unknown
	target: string
	contactId: string
	profileVersion: number
	request?: ProfileAckReference['request']
	/** Only an ordinary flag-OFF legacy probe may tolerate the old schema.
	 * An actual reference/coordination read always requires the column. */
	strict?: boolean
}): Promise<ProfileAckReference[]> {
	const db = args.database as Database
	const scope = and(
		eq(drovrOutbox.target, args.target),
		eq(drovrOutbox.contactId, args.contactId),
	)
	const refs = new Map<string, ProfileAckReference>()
	const consume = (rows: (typeof drovrOutbox.$inferSelect)[]) => {
		if (rows.length >= LIMIT)
			throw new ProfileAckConflict(
				'the contact-indexed metadata lookup exceeds its bounded scope; no absence or replacement can be inferred',
			)
		for (const row of rows) {
			const ack = readHeldContinuationEnvelope(row.heldContinuation)?.profileAck
			if (!ack) continue
			const ref = ack.ref
			if (
				row.target !== args.target ||
				row.contactId !== args.contactId ||
				ref.target !== row.target ||
				ref.contactId !== row.contactId ||
				ref.tenantId !== row.tenantId ||
				ref.journeyId !== row.journeyId ||
				ref.coordinatorKey !== coordinatorKey(ref)
			)
				throw new ProfileAckConflict(
					'the contact-indexed lookup retained a foreign native/control scope',
				)
			if (ack.role === 'tombstone') readAckTombstone(row)
			else {
				assertOutboxWireRow(row)
				const body = parsedBody(row.body)
				const event = body as {
					type?: unknown
					contactId?: unknown
					payload?: { profileVersion?: unknown }
				}
				if (
					row.endpoint !== 'events' ||
					!['contact.profile.updated', 'contact.links.issued'].includes(
						row.eventType ?? '',
					) ||
					event?.type !== row.eventType ||
					event?.contactId !== ref.contactId ||
					event?.payload?.profileVersion !== ref.profileVersion ||
					(ack.role === 'coordinator' && row.dedupeKey !== ref.coordinatorKey)
				)
					throw new ProfileAckConflict(
						'the retained reference does not describe its actual immutable native row',
					)
			}
			if (
				ref.profileVersion === args.profileVersion &&
				(!args.request || sameRequest(ref.request, args.request))
			)
				refs.set(identity(ref), ref)
		}
	}
	const read = async (clause: ReturnType<typeof and>) => {
		const query = () =>
			db
				.select()
				.from(drovrOutbox)
				.where(and(scope, clause))
				.orderBy(asc(drovrOutbox.dedupeKey))
				.limit(LIMIT)
				.for('update')
		return args.strict === false
			? readWithHeldContinuationFallback(query, async () => [])
			: writeHeldContinuationGuard(query)
	}
	if (args.request) {
		const logical = {
			target: args.target,
			endpoint: 'events' as const,
			tenantId: 'org-aihero' as const,
			contactId: args.contactId,
			journeyId: 'contact-directory' as const,
			profileVersion: args.profileVersion,
			request: args.request,
			coordinatorKey: coordinatorKey({
				target: args.target,
				contactId: args.contactId,
				profileVersion: args.profileVersion,
				request: args.request,
			}),
		}
		consume(
			await read(
				inArray(drovrOutbox.dedupeKey, [
					logical.coordinatorKey,
					ackTombstoneKey(logical),
				]),
			),
		)
		if (refs.size) {
			if (refs.size !== 1)
				throw new ProfileAckConflict(
					'the original coordinator and tombstone disagree about their first frozen request',
				)
			return [...refs.values()]
		}
	}
	// An orphaned member still fences its original request. Body identity is
	// included so malformed/foreign metadata cannot hide behind another v.
	const suffix = `:v${args.profileVersion}`
	consume(
		await read(
			and(
				sql`JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.profileAck') IS NOT NULL`,
				or(
					sql`JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.profileAck.ref.profileVersion') = ${args.profileVersion}`,
					sql`JSON_EXTRACT(${drovrOutbox.body}, '$.payload.profileVersion') = ${args.profileVersion}`,
					eq(
						drovrOutbox.idempotencyKey,
						`profile:${args.contactId}:${args.profileVersion}`,
					),
					and(
						eq(drovrOutbox.eventType, 'contact.links.issued'),
						sql`RIGHT(${drovrOutbox.idempotencyKey}, ${suffix.length}) = ${suffix}`,
					),
				),
			),
		),
	)
	// Dedicated controls are bounded separately from the native membership.
	// Decode even older markers before filtering: corrupt sentinels are not
	// authority to classify the current request as never registered.
	consume(await read(eq(drovrOutbox.status, 'ackTombstone')))
	if (args.request && refs.size > 1)
		throw new ProfileAckConflict(
			'the retained members disagree about the first request in this logical scope',
		)
	return [...refs.values()]
}

/** Shared contact-first authority lock for registration and legacy fences. */
export async function lockProfileAckVersion(
	database: unknown,
	contactId: string,
) {
	const db = database as Database
	const [version] = await db
		.select()
		.from(contactProfileVersion)
		.where(eq(contactProfileVersion.contactId, contactId))
		.limit(1)
		.for('update')
	return version
}
