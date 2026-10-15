import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Data, Effect } from 'effect'
import { z } from 'zod'
import { normalizeContactEvent } from '../src/lib/subscriber-marketing/normalize-contact-event'
import {
	OLD_NEWSLETTER_EXIT_CONFIRMED,
	OLD_NEWSLETTER_REFERENCE,
} from '../src/lib/subscriber-marketing/old-newsletter-exit'
import { NEWSLETTER_EXIT_CONFIRMED_EVENT } from '../src/inngest/events/newsletter-exit'
import type {
	ContactRecord,
	ContactEventRecord,
	SideEffectIntent,
} from '../src/lib/subscriber-marketing/types'

export type RecoveryArgs = {
	namespace: 'ai-hero' | 'drovr'
	contactId: string
	contacts?: { namespace: 'ai-hero' | 'drovr'; contactId: string }[]
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
	fingerprint?: string
}
export type RecoveryRuntime = {
	approvalScope: string
	findContactById: (id: string) => Promise<ContactRecord | undefined>
	inspect: (contactId: string) => Promise<RecoverySnapshot>
	scan: (subscriberId: string) => Promise<MembershipScan>
	cleanup?: () => Promise<void>
	persist: (
		input: Omit<ContactEventRecord, 'id'>,
	) => Promise<ContactEventRecord>
	notify: (input: { contactId: string; receiptId: string }) => Promise<number>
	currentMembership: (
		contactId: string,
	) => Promise<'present' | 'exited' | 'absent' | 'unknown'>
	now: () => string
	readback: (row: SideEffectIntent) => Promise<{
		eventDerivable: boolean
		outbox: {
			status: 'pending' | 'delivered' | 'rejected' | 'held'
			attempts: number
		}[]
	}>
}

export const OLD_SEQUENCE_ID = Number(OLD_NEWSLETTER_REFERENCE.split(':')[2])
/** Full scan duration / incomplete cursor lifetime; proof instant remains scan start. */
export const MAX_SCAN_AGE_MS = 120 * 60_000
/** Completed proof may be reused for at most fifteen minutes, including at write time. */
export const MAX_PROOF_AGE_AT_WRITE_MS = 15 * 60_000
const outboxReadbackSchema = z.object({
	eventDerivable: z.boolean(),
	outbox: z.array(
		z.object({
			status: z.enum(['pending', 'delivered', 'rejected', 'held']),
			attempts: z.number().int().nonnegative(),
		}),
	),
})
const scanSchema = z.object({
	membership: z.enum(['absent', 'present', 'unknown']),
	sequenceId: z.literal(2625552),
	complete: z.boolean(),
	pages: z.number().int().nonnegative(),
	subscribers: z.number().int().nonnegative(),
	startedAt: z.string().datetime({ offset: true }),
	completedAt: z.string().datetime({ offset: true }),
	fingerprint: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
})
function freshAbsence(scan: MembershipScan, now: string) {
	const start = Date.parse(scan.startedAt),
		end = Date.parse(scan.completedAt),
		current = Date.parse(now)
	return (
		scan.membership === 'absent' &&
		scan.complete &&
		scan.pages > 0 &&
		scan.sequenceId === OLD_SEQUENCE_ID &&
		Number.isFinite(start) &&
		Number.isFinite(end) &&
		Number.isFinite(current) &&
		start <= end &&
		end <= current &&
		end - start <= MAX_SCAN_AGE_MS &&
		current - end <= MAX_PROOF_AGE_AT_WRITE_MS
	)
}

function proofExpired(scan: MembershipScan, now: string) {
	const end = Date.parse(scan.completedAt),
		current = Date.parse(now)
	return (
		scan.complete &&
		scan.membership === 'absent' &&
		Number.isFinite(end) &&
		Number.isFinite(current) &&
		current - end > MAX_PROOF_AGE_AT_WRITE_MS
	)
}

export class RecoveryRefused extends Data.TaggedError('RecoveryRefused')<{
	reason: string
}> {}

export type RecoveryEnvelope = {
	version: 1
	mode: RecoveryArgs['mode']
	status: 'refused' | 'planned' | 'requested' | 'readback'
	cleanup?: 'failed'
	reason: string | null
	planHash: string | null
	notificationEvent: typeof NEWSLETTER_EXIT_CONFIRMED_EVENT
	counts: { exitReceipts: number; notifications: number }
	checks: {
		contactResolved: boolean
		exactlyOneHeld: boolean
		oldSequenceAbsent: boolean
	}
	scans: MembershipScan[]
	prompt?: string
	results?: RecoveryEnvelope[]
	readback?: {
		rowStatus: SideEffectIntent['status']
		completedAt: string | null
		completionEventDerivable: boolean
		completionDispatch: 'confirmed' | 'attempted' | 'unknown'
		fingerprints: { originalIntentKey: string; completionKey: string }
		outbox: {
			pending: number
			delivered: number
			rejected: number
			held: number
		}
	}
}
const boundary = <A>(reason: string, action: () => Promise<A>) =>
	Effect.tryPromise({
		try: action,
		catch: (error) =>
			error instanceof RecoveryRefused
				? error
				: new RecoveryRefused({ reason }),
	})

/** Sort object keys as well as event/row arrays: DB order isn't approval evidence. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		)
	return value
}
function hashSnapshot(
	contact: ContactRecord,
	state: RecoverySnapshot,
	approvalScope: string,
	scan: MembershipScan,
) {
	return createHash('sha256')
		.update(
			JSON.stringify(
				canonical({
					version: 1,
					contact,
					approvalScope,
					scanFingerprint:
						scan.fingerprint ??
						createHash('sha256').update(JSON.stringify(scan)).digest('hex'),
					state: {
						...state,
						rows: [...state.rows].sort((a, b) => a.id.localeCompare(b.id)),
						identities: [...state.identities].sort((a, b) =>
							a.id.localeCompare(b.id),
						),
						history: [...state.history].sort((a, b) =>
							a.id.localeCompare(b.id),
						),
					},
					sequenceId: OLD_SEQUENCE_ID,
				}),
			),
		)
		.digest('hex')
}

/** Persist the established bound sequence proof, not a tag acknowledgement or
 * app-signup absence. The conservative proof instant is the START of the GET scan. */
export function persistRecoveryExitReceipt(
	input: {
		contact: ContactRecord
		identity: RecoverySnapshot['identities'][number]
		scan: MembershipScan
		approval: string
		planHash: string
	},
	runtime: RecoveryRuntime,
) {
	return Effect.gen(function* () {
		const decodedScan = scanSchema.safeParse(input.scan)
		if (!decodedScan.success)
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'membership-unknown' }),
			)
		const proofNow = runtime.now()
		if (!freshAbsence(decodedScan.data, proofNow))
			return yield* Effect.fail(
				new RecoveryRefused({
					reason: proofExpired(decodedScan.data, proofNow)
						? 'proof-expired'
						: 'membership-unknown',
				}),
			)
		const normalized = normalizeContactEvent({
			provider: 'kit',
			externalId: input.identity.externalId,
			providerEventId: `sequence:2625552:operator-exit:${input.planHash}`,
			eventType: OLD_NEWSLETTER_EXIT_CONFIRMED,
			occurredAt: input.scan.startedAt,
			message: 'Old newsletter absence verified by operator GET scan',
			privacyLevel: 'internal',
		})
		const receipt = yield* boundary('database-unavailable', () => {
			const record: Omit<ContactEventRecord, 'id'> = {
				...normalized,
				contactId: input.contact.id,
				providerIdentityId: input.identity.id,
				providerReference: OLD_NEWSLETTER_REFERENCE,
				createdAt: runtime.now(),
				payloadSummary: {
					...normalized.payloadSummary,
					summary: JSON.stringify({
						operation: 'held-exit-recover',
						approval: input.approval,
						planHash: input.planHash,
						scan: decodedScan.data,
					}),
				},
			}
			// Last clock read before the actual write, after normalization and record construction.
			if (!freshAbsence(decodedScan.data, runtime.now()))
				throw new RecoveryRefused({ reason: 'proof-expired' })
			return runtime.persist(record)
		})
		if (
			receipt.contactId !== input.contact.id ||
			receipt.provider !== 'kit' ||
			receipt.providerReference !== OLD_NEWSLETTER_REFERENCE ||
			receipt.eventType !== OLD_NEWSLETTER_EXIT_CONFIRMED
		)
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'receipt-not-current' }),
			)
		return receipt
	})
}

/** XState v5 transition sketch (persisted receipt is the durable state):
 * inspecting -> refused | planned; planned + WRITE -> verifying -> receiptPersisted
 * -> notificationRequested. A notification is only a wakeup, never completion. */
export function runHeldExitRecovery(
	args: RecoveryArgs,
	runtime: RecoveryRuntime,
) {
	const envelope: RecoveryEnvelope = {
		version: 1,
		mode: args.mode,
		status: 'refused',
		reason: null,
		planHash: null,
		notificationEvent: NEWSLETTER_EXIT_CONFIRMED_EVENT,
		counts: { exitReceipts: 0, notifications: 0 },
		checks: {
			contactResolved: false,
			exactlyOneHeld: false,
			oldSequenceAbsent: false,
		},
		scans: [],
	}
	return Effect.gen(function* () {
		if (args.mode === 'write' && !args.approval.trim())
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'approval-required' }),
			)
		const contact = yield* boundary('database-unavailable', () =>
			resolveRecoveryContact(args, runtime.findContactById),
		)
		if (!contact)
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'contact-missing' }),
			)
		envelope.checks.contactResolved = true
		const state = yield* boundary('database-unavailable', () =>
			runtime.inspect(contact.id),
		)
		const candidates = state.rows.filter(
			(row) =>
				row.type === 'subscribe-evergreen-list' &&
				row.metadata.list === 'shadow-newsletter',
		)
		// inspect is target-scoped and capped at two: a second row proves ambiguity,
		// irrespective of its status or whether its metadata passes our filters.
		if (state.rows.length > 1)
			return yield* Effect.fail(
				new RecoveryRefused({
					reason:
						args.mode === 'readback' ? 'readback-row-count' : 'held-row-count',
				}),
			)
		if (args.mode === 'readback') {
			const row = candidates[0]
			if (candidates.length !== 1 || !row || row.contactId !== contact.id)
				return yield* Effect.fail(
					new RecoveryRefused({ reason: 'readback-row-count' }),
				)
			const raw = yield* boundary('database-unavailable', () =>
				runtime.readback(row),
			)
			const decoded = outboxReadbackSchema.safeParse(raw)
			const owner = z
				.object({ intentKey: z.string().min(1) })
				.safeParse(row.metadata.drovr)
			const timestamp = z
				.string()
				.datetime({ offset: true })
				.nullable()
				.safeParse(row.completedAt ?? null)
			const status = z
				.enum([
					'dry-run',
					'gated',
					'blocked',
					'pending',
					'sending',
					'held-for-exit',
					'completed',
					'failed',
					'skipped',
				])
				.safeParse(row.status)
			if (
				!decoded.success ||
				!owner.success ||
				!timestamp.success ||
				!status.success
			)
				return yield* Effect.fail(
					new RecoveryRefused({ reason: 'readback-unavailable' }),
				)
			const outbox = { pending: 0, delivered: 0, rejected: 0, held: 0 }
			for (const entry of decoded.data.outbox) outbox[entry.status] += 1
			envelope.readback = {
				rowStatus: status.data,
				completedAt: timestamp.data,
				completionEventDerivable: decoded.data.eventDerivable,
				fingerprints: {
					originalIntentKey: createHash('sha256')
						.update(owner.data.intentKey)
						.digest('hex'),
					completionKey: createHash('sha256')
						.update(`completion:${owner.data.intentKey}`)
						.digest('hex'),
				},
				completionDispatch:
					outbox.delivered > 0
						? 'confirmed'
						: decoded.data.outbox.some((entry) => entry.attempts > 0)
							? 'attempted'
							: 'unknown',
				outbox,
			}
			envelope.status = 'readback'
			return envelope
		}
		const held = candidates.filter((row) => row.status === 'held-for-exit')
		if (
			held.length === 0 &&
			state.rows.some((row) => row.status !== 'held-for-exit')
		)
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'already-recovered' }),
			)
		if (held.length !== 1)
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'held-row-count' }),
			)
		const row = held[0]
		if (
			!row ||
			row.contactId !== contact.id ||
			row.provider !== 'kit' ||
			row.completedAt ||
			row.idempotencyKey !==
				`contact:${contact.id}:evergreen:list:shadow-newsletter` ||
			!row.reviewReasons.includes('old-newsletter-exit-unconfirmed')
		)
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'invalid-held-row' }),
			)
		envelope.checks.exactlyOneHeld = true
		const identity = state.identities[0]
		if (
			state.identities.length !== 1 ||
			!identity ||
			identity.contactId !== contact.id ||
			!/^[1-9]\d*$/.test(identity.externalId) ||
			!Number.isSafeInteger(Number(identity.externalId))
		)
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'identity-unproven' }),
			)
		const rawScan = yield* boundary('provider-unavailable', () =>
			runtime.scan(identity.externalId),
		)
		const decodedScan = scanSchema.safeParse(rawScan)
		if (!decodedScan.success)
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'membership-unknown' }),
			)
		const scan = decodedScan.data
		envelope.scans = [scan]
		if (scan.membership === 'present')
			return yield* Effect.fail(
				new RecoveryRefused({ reason: 'old-sequence-member' }),
			)
		const proofNow = runtime.now()
		if (!freshAbsence(scan, proofNow))
			return yield* Effect.fail(
				new RecoveryRefused({
					reason: proofExpired(scan, proofNow)
						? 'proof-expired'
						: 'provider-unavailable',
				}),
			)
		envelope.checks.oldSequenceAbsent = true
		envelope.planHash = hashSnapshot(
			contact,
			state,
			runtime.approvalScope,
			scan,
		)
		if (args.mode === 'write') {
			if (args.planHash !== envelope.planHash)
				return yield* Effect.fail(
					new RecoveryRefused({ reason: 'plan-hash-mismatch' }),
				)
			const currentContact = yield* boundary('database-unavailable', () =>
				runtime.findContactById(contact.id),
			)
			const current = yield* boundary('database-unavailable', () =>
				runtime.inspect(contact.id),
			)
			if (
				!currentContact ||
				hashSnapshot(currentContact, current, runtime.approvalScope, scan) !==
					envelope.planHash
			)
				return yield* Effect.fail(
					new RecoveryRefused({ reason: 'snapshot-changed' }),
				)
			const receipt = yield* persistRecoveryExitReceipt(
				{
					contact,
					identity,
					scan,
					approval: args.approval,
					planHash: envelope.planHash,
				},
				runtime,
			)
			envelope.counts.exitReceipts = 1
			const membership = yield* boundary('database-unavailable', () =>
				runtime.currentMembership(contact.id),
			)
			if (membership !== 'exited')
				return yield* Effect.fail(
					new RecoveryRefused({ reason: 'receipt-not-current' }),
				)
			const notifications = yield* boundary('notification-unavailable', () =>
				runtime.notify({ contactId: contact.id, receiptId: receipt.id }),
			)
			if (notifications < 1)
				return yield* Effect.fail(
					new RecoveryRefused({ reason: 'notification-unavailable' }),
				)
			envelope.counts.notifications = notifications
			envelope.status = 'requested'
			// Retain the shared fresh proof; housekeeping cannot undo an acknowledged write.
			if (runtime.cleanup)
				yield* boundary('scan-cleanup-failed', runtime.cleanup).pipe(
					Effect.catchAll(() =>
						Effect.sync(() => {
							envelope.cleanup = 'failed'
						}),
					),
				)
		} else {
			envelope.status = 'planned'
			envelope.counts = { exitReceipts: 1, notifications: 1 }
		}
		return envelope
	}).pipe(
		Effect.catchAll((error) =>
			Effect.succeed({
				...envelope,
				reason: error.reason,
				prompt: recoveryPrompt(error.reason),
				status: 'refused' as const,
			}),
		),
	)
}

export function parseHeldRecoveryArgs(argv: readonly string[]): RecoveryArgs {
	let selector:
		| { namespace: 'ai-hero' | 'drovr'; contactId: string }
		| undefined
	const contacts: { namespace: 'ai-hero' | 'drovr'; contactId: string }[] = []
	let mode: RecoveryArgs['mode'] = 'dry-run'
	let approval: string | undefined, planHash: string | undefined
	let modeSelected = false
	const seen = new Set<string>()
	const invalid = () => new RecoveryRefused({ reason: 'arguments-invalid' })
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index]
		if (
			!flag ||
			(seen.has(flag) &&
				flag !== '--contact-id' &&
				flag !== '--drovr-contact-id')
		)
			throw invalid()
		seen.add(flag)
		if (flag === '--write' || flag === '--readback' || flag === '--dry-run') {
			if (modeSelected) throw invalid()
			modeSelected = true
			mode =
				flag === '--write'
					? 'write'
					: flag === '--readback'
						? 'readback'
						: 'dry-run'
			continue
		}
		if (
			![
				'--contact-id',
				'--drovr-contact-id',
				'--approval',
				'--plan-hash',
			].includes(flag)
		)
			throw invalid()
		const value = argv[++index]
		if (!value || value.startsWith('--')) throw invalid()
		if (flag === '--contact-id' || flag === '--drovr-contact-id') {
			if (
				contacts.some((item) => item.contactId === value) ||
				!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,254}$/.test(value)
			)
				throw invalid()
			const selected = {
				namespace:
					flag === '--contact-id' ? ('ai-hero' as const) : ('drovr' as const),
				contactId: value,
			}
			selector ??= selected
			contacts.push(selected)
		} else if (flag === '--approval') approval = value.trim()
		else planHash = value
	}
	if (!selector) throw invalid()
	if (mode !== 'dry-run' && contacts.length !== 1) throw invalid()
	if (mode === 'write') {
		if (!approval) throw new RecoveryRefused({ reason: 'approval-required' })
		if (!planHash || !/^[a-f0-9]{64}$/.test(planHash)) throw invalid()
		return { ...selector, mode, approval, planHash }
	}
	if (approval !== undefined || planHash !== undefined) throw invalid()
	return { ...selector, mode, ...(contacts.length > 1 ? { contacts } : {}) }
}

export type RecoveryRuntimeLoader = (
	args: RecoveryArgs,
) => Promise<{ runtime: RecoveryRuntime; close: () => Promise<void> }>
export function runHeldRecoveryCommand(
	argv: readonly string[],
	load: RecoveryRuntimeLoader,
) {
	let result: RecoveryEnvelope = {
		version: 1,
		mode: 'dry-run',
		status: 'refused',
		reason: null,
		planHash: null,
		notificationEvent: NEWSLETTER_EXIT_CONFIRMED_EVENT,
		counts: { exitReceipts: 0, notifications: 0 },
		checks: {
			contactResolved: false,
			exactlyOneHeld: false,
			oldSequenceAbsent: false,
		},
		scans: [],
	}
	return Effect.gen(function* () {
		const args = yield* Effect.try({
			try: () => parseHeldRecoveryArgs(argv),
			catch: (error) =>
				error instanceof RecoveryRefused
					? error
					: new RecoveryRefused({ reason: 'arguments-invalid' }),
		})
		result.mode = args.mode
		yield* Effect.acquireUseRelease(
			boundary('runtime-unavailable', () => load(args)),
			({ runtime }) =>
				runHeldRecoveryBatch(args, runtime).pipe(
					Effect.tap((value) =>
						Effect.sync(() => {
							result = value
						}),
					),
				),
			({ close }) =>
				boundary('runtime-close-failed', close).pipe(
					Effect.catchAll((error) =>
						Effect.sync(() => {
							result =
								result.status === 'requested'
									? { ...result, cleanup: 'failed' }
									: { ...result, status: 'refused', reason: error.reason }
						}),
					),
				),
		)
		return result
	}).pipe(
		Effect.catchAll((error) =>
			Effect.succeed({
				...result,
				status: 'refused' as const,
				reason: error.reason,
			}),
		),
		Effect.map((value) =>
			value.status === 'refused'
				? { ...value, prompt: recoveryPrompt(value.reason ?? 'internal-error') }
				: value,
		),
		// Final process fence only: never print an unexpected defect, SQL text or provider body.
		Effect.catchAllCause(() =>
			Effect.succeed({
				...result,
				status: 'refused' as const,
				reason: 'internal-error',
				prompt: recoveryPrompt('internal-error'),
			}),
		),
	)
}

/** Literal operator prompt. Fixed vocabulary only; never interpolate identifiers or causes. */
export function recoveryPrompt(reason: string) {
	const explanations: Record<string, string> = {
		'provider-unavailable':
			'the provider did not supply a complete fresh membership scan',
		'membership-unknown': 'the membership evidence is invalid',
		'identity-unproven':
			'exactly one bound provider identity could not be proven',
		'arguments-invalid': 'the selectors or mode are invalid',
		'old-sequence-member': 'the scan found membership in the old sequence',
		'plan-hash-mismatch':
			'the supplied approval hash no longer matches the plan',
		'runtime-unavailable': 'the deployment runtime could not be loaded',
		'database-unavailable': 'the database could not be read',
		'scan-locked': 'another recovery operator holds the scan lease',
		'scan-cache-unsafe':
			'the scan cache directory or file is not private and operator-owned',
		'scan-cleanup-failed': 'post-write housekeeping did not complete',
		'proof-expired': 'the completed membership proof has expired',
	}
	const why = explanations[reason] ?? 'a recovery precondition was not met'
	const fix =
		reason === 'proof-expired'
			? 'rerun the dry run and write within 15 minutes of scan completion'
			: reason === 'scan-locked'
				? 'wait for the lease owner; remove a crash lock only after verifying its named process stopped'
				: reason === 'scan-cache-unsafe'
					? 'restore current-user ownership and private permissions without following symlinks'
					: 'verify the deployment and preconditions, then rerun a dry run'
	return `RecoveryRefused: you requested held-exit recovery, and it failed because ${why}. Accepted: one proven identity per held contact and an authenticated complete fresh GET scan with exact counts; writes require one contact and the matching plan hash. Fix: ${fix}. Debug: inspect the private operator scan checkpoint and redacted checks.`
}

/** One runtime owns the shared scan. Output order matches selector order, without identifiers. */
export function runHeldRecoveryBatch(
	args: RecoveryArgs,
	runtime: RecoveryRuntime,
): Effect.Effect<RecoveryEnvelope> {
	const selectors = args.contacts
	if (!selectors) return runHeldExitRecovery(args, runtime)
	if (args.mode !== 'dry-run')
		return Effect.succeed({
			version: 1 as const,
			mode: args.mode,
			status: 'refused' as const,
			reason: 'arguments-invalid',
			planHash: null,
			notificationEvent: NEWSLETTER_EXIT_CONFIRMED_EVENT,
			counts: { exitReceipts: 0, notifications: 0 },
			checks: {
				contactResolved: false,
				exactlyOneHeld: false,
				oldSequenceAbsent: false,
			},
			scans: [],
		})
	return Effect.gen(function* () {
		const results: RecoveryEnvelope[] = []
		for (const selector of selectors)
			results.push(
				yield* runHeldExitRecovery({ ...selector, mode: 'dry-run' }, runtime),
			)
		const first = results[0]!
		const refused = results.find((result) => result.status === 'refused')
		return {
			...first,
			status: refused ? ('refused' as const) : ('planned' as const),
			reason: refused?.reason ?? null,
			prompt: refused?.prompt,
			checks: {
				contactResolved: results.every(
					(result) => result.checks.contactResolved,
				),
				exactlyOneHeld: results.every((result) => result.checks.exactlyOneHeld),
				oldSequenceAbsent: results.every(
					(result) => result.checks.oldSequenceAbsent,
				),
			},
			counts: results.reduce(
				(counts, result) => ({
					exitReceipts: counts.exitReceipts + result.counts.exitReceipts,
					notifications: counts.notifications + result.counts.notifications,
				}),
				{ exitReceipts: 0, notifications: 0 },
			),
			planHash: null,
			scans: results.find((result) => result.scans.length)?.scans ?? [],
			results,
		}
	})
}

/** drovr's delivery payload carries the AI Hero contact id unchanged. */
export async function resolveRecoveryContact(
	input: { namespace: 'ai-hero' | 'drovr'; contactId: string },
	findContactById: (id: string) => Promise<ContactRecord | undefined>,
): Promise<ContactRecord | undefined> {
	const contact = await findContactById(input.contactId)
	return contact?.id === input.contactId ? contact : undefined
}

/** The only process entrypoint. Importing the module never creates live clients. */
async function main() {
	const result = await Effect.runPromise(
		runHeldRecoveryCommand(process.argv.slice(2), async (args) => {
			const { createProductionHeldRecoveryRuntime } =
				await import('./held-exit-recover-runtime')
			return createProductionHeldRecoveryRuntime(args)
		}),
	)
	await Effect.runPromise(
		Effect.sync(() => {
			process.stdout.write(`${JSON.stringify(result)}\n`)
			process.exitCode = result.status === 'refused' ? 1 : 0
		}),
	)
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
	void main()
