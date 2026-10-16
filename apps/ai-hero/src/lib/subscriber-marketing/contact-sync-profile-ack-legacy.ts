import { contactProfileVersion } from '@/db/contact-sync-schema'
import { eq } from 'drizzle-orm'
import { retryHeldBatchTransaction } from './contact-sync-held-batch-transaction'
import { profileAckFlagEnabled } from './contact-sync-profile-ack-flag'
import { ProfileAckConflict } from './contact-sync-profile-ack'
import { lookupProfileAckReferences } from './contact-sync-profile-ack-lookup'
import type { ProfileAckReference } from './contact-sync-profile-ack-schema'

type Database = typeof import('@/db').db
function missingOutboxTable(error: unknown): boolean {
	let cause = error
	for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
		const value = cause as { code?: unknown; errno?: unknown; cause?: unknown }
		if (value.code === 'ER_NO_SUCH_TABLE' || value.errno === 1146) return true
		cause = value.cause
	}
	return false
}
function periodOf(value: string | Date | null): string | undefined {
	return value instanceof Date ? value.toISOString().slice(0, 7) : value?.slice(0, 7)
}
/** Legacy NOW is ONLY for a never-registered, flag-OFF request. Return whether
 * the writer really ran; a suppressed write is not optimistic coverage.
 * Unknown old callers cannot refresh an already-acknowledged version. A new
 * monthly request has to name its distinct period, never recreate a prior one.
 */
export async function acknowledgeLegacyProfileVersion(args: {
	database: unknown
	contactId: string
	target: string
	profileVersion: number
	request?: ProfileAckReference['request']
	enabled: () => Promise<boolean>
	write: (transaction: unknown) => Promise<void>
}): Promise<boolean> {
	const db = args.database as Pick<Database, 'transaction'>
	if (typeof db?.transaction !== 'function') throw new ProfileAckConflict('the legacy ACK fence cannot provide the contact-first transaction')
	return retryHeldBatchTransaction(async () => {
		if (await profileAckFlagEnabled({ readFlag: args.enabled })) return false
		return db.transaction(async tx => {
			const [version] = await tx.select().from(contactProfileVersion).where(eq(contactProfileVersion.contactId, args.contactId)).limit(1).for('update')
			if (!version || Number(version.profileVersion) !== args.profileVersion) return false
			let known: ProfileAckReference[]
			try {
				known = await lookupProfileAckReferences({ database: tx, target: args.target, contactId: args.contactId, profileVersion: args.profileVersion, request: args.request, strict: false })
			} catch (error) {
				if (!missingOutboxTable(error)) throw error
				known = []
			}
			if (known.length) return false
			const acknowledged = version.acknowledgedVersion != null && Number(version.acknowledgedVersion) === args.profileVersion
			if (acknowledged && args.request?.kind !== 'restate') return false
			if (args.request?.kind === 'restate') {
				const previous = periodOf(version.acknowledgedAt)
				if (previous && previous >= args.request.period) return false
			}
			await args.write(tx)
			return true
		})
	})
}
