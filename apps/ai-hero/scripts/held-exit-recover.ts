import { createHash } from 'node:crypto'
import { Data, Effect } from 'effect'
import { z } from 'zod'
import { normalizeContactEvent } from '../src/lib/subscriber-marketing/normalize-contact-event'
import { OLD_NEWSLETTER_EXIT_CONFIRMED, OLD_NEWSLETTER_REFERENCE } from '../src/lib/subscriber-marketing/old-newsletter-exit'
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
	currentMembership: (contactId: string) => Promise<'present' | 'exited' | 'absent' | 'unknown'>
	now: () => string
	readback: (row: SideEffectIntent) => Promise<{
		eventDerivable: boolean
		outbox: { status: 'pending' | 'delivered' | 'rejected' | 'held'; attempts: number }[]
	}>
}

export const OLD_SEQUENCE_ID = Number(OLD_NEWSLETTER_REFERENCE.split(':')[2])
export const MAX_SCAN_AGE_MS = 5 * 60_000
const scanSchema = z.object({
	membership: z.enum(['absent', 'present', 'unknown']), sequenceId: z.literal(2625552),
	complete: z.boolean(), pages: z.number().int().nonnegative(), subscribers: z.number().int().nonnegative(),
	startedAt: z.string().datetime({ offset: true }), completedAt: z.string().datetime({ offset: true }),
})
function freshAbsence(scan: MembershipScan, now: string) {
	const start = Date.parse(scan.startedAt), end = Date.parse(scan.completedAt), current = Date.parse(now)
	return scan.membership === 'absent' && scan.complete && scan.pages > 0 &&
		scan.sequenceId === OLD_SEQUENCE_ID && Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(current) &&
		start <= end && end <= current && current - start <= MAX_SCAN_AGE_MS
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
	readback?: {
		rowStatus: SideEffectIntent['status']
		completedAt: string | null
		completionEventDerivable: boolean
		completionDispatch: 'confirmed' | 'attempted' | 'unknown'
		outbox: { pending: number; delivered: number; rejected: number; held: number }
	}
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

/** Persist the established bound sequence proof, not a tag acknowledgement or
 * app-signup absence. The conservative proof instant is the START of the GET scan. */
export function persistRecoveryExitReceipt(input: {
	contact: ContactRecord
	identity: RecoverySnapshot['identities'][number]
	scan: MembershipScan
	approval: string
	planHash: string
}, runtime: RecoveryRuntime) {
	return Effect.gen(function* () {
		if (!scanSchema.safeParse(input.scan).success || !freshAbsence(input.scan, runtime.now()))
			return yield* Effect.fail(new RecoveryRefused({ reason: 'membership-unknown' }))
		const normalized = normalizeContactEvent({ provider: 'kit', externalId: input.identity.externalId,
			providerEventId: `sequence:2625552:operator-exit:${input.planHash}`,
			eventType: OLD_NEWSLETTER_EXIT_CONFIRMED, occurredAt: input.scan.startedAt,
			message: 'Old newsletter absence verified by operator GET scan', privacyLevel: 'internal' })
		const receipt = yield* boundary('database-unavailable', () => runtime.persist({ ...normalized,
			contactId: input.contact.id, providerIdentityId: input.identity.id,
			providerReference: OLD_NEWSLETTER_REFERENCE, createdAt: runtime.now(),
			payloadSummary: { ...normalized.payloadSummary,
				summary: JSON.stringify({ operation: 'held-exit-recover', approval: input.approval,
					planHash: input.planHash, scan: input.scan }) } }))
		if (receipt.contactId !== input.contact.id || receipt.provider !== 'kit' ||
			receipt.providerReference !== OLD_NEWSLETTER_REFERENCE || receipt.eventType !== OLD_NEWSLETTER_EXIT_CONFIRMED)
			return yield* Effect.fail(new RecoveryRefused({ reason: 'receipt-not-current' }))
		return receipt
	})
}

/** XState v5 transition sketch (persisted receipt is the durable state):
 * inspecting -> refused | planned; planned + WRITE -> verifying -> receiptPersisted
 * -> notificationRequested. A notification is only a wakeup, never completion. */
export function runHeldExitRecovery(args: RecoveryArgs, runtime: RecoveryRuntime) {
	const envelope: RecoveryEnvelope = { version: 1, mode: args.mode, status: 'refused',
		reason: null, planHash: null, counts: { exitReceipts: 0, notifications: 0 },
		checks: { contactResolved: false, exactlyOneHeld: false, oldSequenceAbsent: false }, scans: [] }
	return Effect.gen(function* () {
		if (args.mode === 'write' && !args.approval.trim())
			return yield* Effect.fail(new RecoveryRefused({ reason: 'approval-required' }))
		const contact = yield* boundary('database-unavailable', () => resolveRecoveryContact(args, runtime.findContactById))
		if (!contact) return yield* Effect.fail(new RecoveryRefused({ reason: 'contact-missing' }))
		envelope.checks.contactResolved = true
		const state = yield* boundary('database-unavailable', () => runtime.inspect(contact.id))
		const held = state.rows.filter((row) => row.status === 'held-for-exit' &&
			row.type === 'subscribe-evergreen-list' && row.metadata.list === 'shadow-newsletter')
		if (held.length === 0 && state.rows.some((row) => row.status !== 'held-for-exit'))
			return yield* Effect.fail(new RecoveryRefused({ reason: 'already-recovered' }))
		if (held.length !== 1) return yield* Effect.fail(new RecoveryRefused({ reason: 'held-row-count' }))
		const row = held[0]
		if (!row || row.contactId !== contact.id || row.provider !== 'kit' || row.completedAt ||
			row.idempotencyKey !== `contact:${contact.id}:evergreen:list:shadow-newsletter` ||
			!row.reviewReasons.includes('old-newsletter-exit-unconfirmed'))
			return yield* Effect.fail(new RecoveryRefused({ reason: 'invalid-held-row' }))
		envelope.checks.exactlyOneHeld = true
		const identity = state.identities[0]
		if (state.identities.length !== 1 || !identity || identity.contactId !== contact.id ||
			!/^[1-9]\d*$/.test(identity.externalId) || !Number.isSafeInteger(Number(identity.externalId)))
			return yield* Effect.fail(new RecoveryRefused({ reason: 'identity-unproven' }))
		const rawScan = yield* boundary('provider-unavailable', () => runtime.scan(identity.externalId))
		const decodedScan = scanSchema.safeParse(rawScan)
		if (!decodedScan.success) return yield* Effect.fail(new RecoveryRefused({ reason: 'membership-unknown' }))
		const scan = decodedScan.data
		envelope.scans = [scan]
		if (scan.membership === 'present')
			return yield* Effect.fail(new RecoveryRefused({ reason: 'old-sequence-member' }))
		if (!freshAbsence(scan, runtime.now()))
			return yield* Effect.fail(new RecoveryRefused({ reason: 'membership-unknown' }))
		envelope.checks.oldSequenceAbsent = true
		envelope.planHash = hashSnapshot(contact, state)
		if (args.mode === 'write') {
			if (args.planHash !== envelope.planHash)
				return yield* Effect.fail(new RecoveryRefused({ reason: 'plan-hash-mismatch' }))
			const currentContact = yield* boundary('database-unavailable', () => runtime.findContactById(contact.id))
			const current = yield* boundary('database-unavailable', () => runtime.inspect(contact.id))
			if (!currentContact || hashSnapshot(currentContact, current) !== envelope.planHash)
				return yield* Effect.fail(new RecoveryRefused({ reason: 'snapshot-changed' }))
			const receipt = yield* persistRecoveryExitReceipt({ contact, identity, scan,
				approval: args.approval, planHash: envelope.planHash }, runtime)
			envelope.counts.exitReceipts = 1
			const membership = yield* boundary('database-unavailable', () => runtime.currentMembership(contact.id))
			if (membership !== 'exited')
				return yield* Effect.fail(new RecoveryRefused({ reason: 'receipt-not-current' }))
			const notifications = yield* boundary('notification-unavailable', () => runtime.notify({ contactId: contact.id, receiptId: receipt.id }))
			if (notifications < 1) return yield* Effect.fail(new RecoveryRefused({ reason: 'notification-unavailable' }))
			envelope.counts.notifications = notifications
			envelope.status = 'requested'
		} else {
			envelope.status = 'planned'
			envelope.counts = { exitReceipts: 1, notifications: 1 }
		}
		return envelope
	}).pipe(Effect.catchAll((error) => Effect.succeed({ ...envelope, reason: error.reason,
		status: 'refused' as const })))
}

/** drovr's delivery payload carries the AI Hero contact id unchanged. */
export async function resolveRecoveryContact(
	input: { namespace: 'ai-hero' | 'drovr'; contactId: string },
	findContactById: (id: string) => Promise<ContactRecord | undefined>,
): Promise<ContactRecord | undefined> {
	const contact = await findContactById(input.contactId)
	return contact?.id === input.contactId ? contact : undefined
}
