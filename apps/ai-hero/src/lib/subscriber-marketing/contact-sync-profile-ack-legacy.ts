import { contactProfileVersion } from '@/db/contact-sync-schema'
import { drovrOutbox } from '@/db/drovr-outbox-schema'
import { and, eq, sql } from 'drizzle-orm'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import { ProfileAckConflict } from './contact-sync-profile-ack'
import {
	readHeldContinuationEnvelope,
	readWithHeldContinuationFallback,
} from './drovr-outbox-control'

type Database = typeof import('@/db').db
function missingOutboxTable(error: unknown): boolean {
	let cause = error
	for (
		let depth = 0;
		depth < 6 && cause && typeof cause === 'object';
		depth++
	) {
		const value = cause as { code?: unknown; errno?: unknown; cause?: unknown }
		if (value.code === 'ER_NO_SUCH_TABLE' || value.errno === 1146) return true
		cause = value.cause
	}
	return false
}

/** The old NOW-based ACK is ONLY for never-registered, flag-OFF requests.
 * Same contact-first lock as registration/completion; a reference/tombstone
 * cannot appear between the fence read and the legacy write. The version
 * fence uses the deployment target/contact index, never a whole-table scan.
 * This is not a replacement for carrying SDK references after evidence purge.
 */
export async function acknowledgeLegacyProfileVersion(args: {
	database: unknown
	contactId: string
	target: string
	profileVersion: number
	enabled: () => Promise<boolean>
	write: (transaction: unknown) => Promise<void>
}): Promise<void> {
	const db = args.database as Pick<Database, 'transaction'>
	if (typeof db?.transaction !== 'function')
		throw new ProfileAckConflict(
			'the legacy ACK fence cannot provide the contact-first transaction',
		)
	await retryHeldBatchTransaction(async () => {
		if (await profileAckFlagEnabled({ readFlag: args.enabled })) return
		await db.transaction(async (tx) => {
			const [version] = await tx
				.select({ version: contactProfileVersion.profileVersion })
				.from(contactProfileVersion)
				.where(eq(contactProfileVersion.contactId, args.contactId))
				.limit(1)
				.for('update')
			if (!version || Number(version.version) !== args.profileVersion) return
			const read = () =>
				tx
					.select({ heldContinuation: drovrOutbox.heldContinuation })
					.from(drovrOutbox)
					.where(
						and(
							eq(drovrOutbox.target, args.target),
							eq(drovrOutbox.contactId, args.contactId),
							sql`JSON_UNQUOTE(JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.profileAck.ref.contactId')) = ${args.contactId}`,
							sql`JSON_EXTRACT(${drovrOutbox.heldContinuation}, '$.profileAck.ref.profileVersion') = ${args.profileVersion}`,
						),
					)
					.limit(1)
					.for('update')
			let rows: { heldContinuation: unknown }[]
			try {
				rows = await readWithHeldContinuationFallback(read, async () => [])
			} catch (error) {
				// An absent pre-outbox schema cannot contain new ACK metadata.
				// Other read failures never authorize the optimistic write.
				if (!missingOutboxTable(error)) throw error
				rows = []
			}
			if (rows.length) {
				const state = readHeldContinuationEnvelope(
					rows[0]!.heldContinuation,
				)?.profileAck
				if (
					!state ||
					state.ref.contactId !== args.contactId ||
					state.ref.target !== args.target ||
					state.ref.profileVersion !== args.profileVersion
				)
					throw new ProfileAckConflict(
						'the retained legacy ACK fence is malformed or foreign',
					)
				return
			}
			await args.write(tx)
		})
	})
}
