import { createHash } from 'node:crypto'
import { Data, Effect } from 'effect'
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

export class RecoveryRefused extends Data.TaggedError('RecoveryRefused')<{
	reason: string
}> {}

export type RecoveryEnvelope = {
	version: 1
	mode: RecoveryArgs['mode']
	status: 'refused' | 'planned' | 'requested' | 'readback'
	reason: string | null
	planHash: string | null
	counts: { exitReceipts: number; notifications: number }
	checks: { contactResolved: boolean; exactlyOneHeld: boolean; oldSequenceAbsent: boolean }
	scans: MembershipScan[]
}
const boundary = <A>(reason: string, action: () => Promise<A>) =>
	Effect.tryPromise({ try: action, catch: () => new RecoveryRefused({ reason }) })

/** Sort object keys as well as event/row arrays: DB order isn't approval evidence. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value && typeof value === 'object') return Object.fromEntries(
		Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
	return value
}
function hashSnapshot(contact: ContactRecord, state: RecoverySnapshot) {
	return createHash('sha256').update(JSON.stringify(canonical({ version: 1,
		contact, state: { ...state, rows: [...state.rows].sort((a, b) => a.id.localeCompare(b.id)),
			identities: [...state.identities].sort((a, b) => a.id.localeCompare(b.id)),
			history: [...state.history].sort((a, b) => a.id.localeCompare(b.id)) }, sequenceId: 2625552 }))).digest('hex')
}

export function runHeldExitRecovery(args: RecoveryArgs, runtime: RecoveryRuntime) {
	const envelope: RecoveryEnvelope = { version: 1, mode: args.mode, status: 'refused',
		reason: null, planHash: null, counts: { exitReceipts: 0, notifications: 0 },
		checks: { contactResolved: false, exactlyOneHeld: false, oldSequenceAbsent: false }, scans: [] }
	return Effect.gen(function* () {
		const contact = yield* boundary('database-unavailable', () => resolveRecoveryContact(args, runtime.findContactById))
		if (!contact) return yield* Effect.fail(new RecoveryRefused({ reason: 'contact-missing' }))
		envelope.checks.contactResolved = true
		const state = yield* boundary('database-unavailable', () => runtime.inspect(contact.id))
		const held = state.rows.filter((row) => row.status === 'held-for-exit' &&
			row.type === 'subscribe-evergreen-list' && row.metadata.list === 'shadow-newsletter')
		if (held.length !== 1) return yield* Effect.fail(new RecoveryRefused({ reason: 'held-row-count' }))
		envelope.checks.exactlyOneHeld = true
		const identity = state.identities[0]
		if (state.identities.length !== 1 || !identity || identity.contactId !== contact.id)
			return yield* Effect.fail(new RecoveryRefused({ reason: 'identity-unproven' }))
		const scan = yield* boundary('provider-unavailable', () => runtime.scan(identity.externalId))
		envelope.scans = [scan]
		envelope.checks.oldSequenceAbsent = scan.membership === 'absent'
		envelope.planHash = hashSnapshot(contact, state)
		envelope.status = 'planned'
		envelope.counts = { exitReceipts: 1, notifications: 1 }
		return envelope
	}).pipe(Effect.catchAll((error) => Effect.succeed({ ...envelope, reason: error.reason,
		status: 'refused' as const, counts: { exitReceipts: 0, notifications: 0 } })))
}

/** drovr's delivery payload carries the AI Hero contact id unchanged. */
export async function resolveRecoveryContact(
	input: { namespace: 'ai-hero' | 'drovr'; contactId: string },
	findContactById: (id: string) => Promise<ContactRecord | undefined>,
): Promise<ContactRecord | undefined> {
	const contact = await findContactById(input.contactId)
	return contact?.id === input.contactId ? contact : undefined
}
