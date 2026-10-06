import { Effect } from 'effect'
import type { ContactRecord, ContactEventRecord, SideEffectIntent } from '../src/lib/subscriber-marketing/types'

export type RecoveryArgs = {
	namespace: 'ai-hero' | 'drovr'
	contactId: string
} & (
	| { mode: 'dry-run' | 'readback' }
	| { mode: 'write'; approval: string; planHash: string }
)
export type RecoverySnapshot = {
	rows: SideEffectIntent[]
	identities: { id: string; contactId: string; externalId: string }[]
	history: ContactEventRecord[]
}
export type MembershipScan = {
	membership: 'absent' | 'present' | 'unknown'
	sequenceId: number
	complete: boolean
	pages: number
	subscribers: number
	startedAt: string
	completedAt: string
}
export type RecoveryRuntime = {
	findContactById: (id: string) => Promise<ContactRecord | undefined>
	inspect: (contactId: string) => Promise<RecoverySnapshot>
	scan: (subscriberId: string) => Promise<MembershipScan>
	persist: (input: Omit<ContactEventRecord, 'id'>) => Promise<ContactEventRecord>
	notify: (input: { contactId: string; receiptId: string }) => Promise<number>
}

export function runHeldExitRecovery(args: RecoveryArgs, runtime: RecoveryRuntime) {
	return Effect.succeed({ version: 1, mode: args.mode, status: 'refused',
		reason: 'not-implemented', planHash: null, counts: { exitReceipts: 0, notifications: 0 },
		checks: { contactResolved: false, exactlyOneHeld: false, oldSequenceAbsent: false },
		scans: [] as MembershipScan[] })
}

/** drovr's delivery payload carries the AI Hero contact id unchanged. */
export async function resolveRecoveryContact(
	input: { namespace: 'ai-hero' | 'drovr'; contactId: string },
	findContactById: (id: string) => Promise<ContactRecord | undefined>,
): Promise<ContactRecord | undefined> {
	const contact = await findContactById(input.contactId)
	return contact?.id === input.contactId ? contact : undefined
}
