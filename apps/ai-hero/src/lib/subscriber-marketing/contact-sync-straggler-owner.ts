import { createHash, randomUUID } from 'node:crypto'
import { NonRetriableError } from 'inngest'
import type { DrovrContactSyncRetryRequested } from '@/inngest/events/drovr'
import type { runContactSyncStragglerRetry } from './contact-sync-straggler-retry'

export const STRAGGLER_PARK_AFTER_MS = 7 * 24 * 60 * 60 * 1000
export type StragglerOwnerRef = {
	protocol: 1
	startedAt: number
	generation?: string
}
export type StragglerOwner = {
	generation: string
	state: 'active' | 'complete' | 'parked'
	startedAt: number
	deadline: number
	next: number
	/** Exact-set fingerprint only; different does not prove any key is new. */
	membershipDigest?: string
}
type Decision = {
	status: 'claimed' | 'joined' | 'stale' | 'parked'
	owner: StragglerOwner
	now: number
}
export type StragglerOwnerStore = {
	update<T>(
		key: string,
		change: (
			owner: StragglerOwner | undefined,
			now: number,
		) => { owner: StragglerOwner; value: T },
	): Promise<T>
}
export function stragglerOwnerKey(contactId: string) {
	return `straggler-owner:${createHash('sha256').update(contactId).digest('hex')}`
}
export function claimStragglerOwner(
	owner: StragglerOwner | undefined,
	ref: StragglerOwnerRef,
	attempt: number,
	now: number,
	membershipDigest?: string,
): { owner: StragglerOwner; value: Decision } {
	if (
		!Number.isSafeInteger(attempt) ||
		attempt < 1 ||
		!Number.isSafeInteger(ref.startedAt) ||
		ref.startedAt < 0 ||
		ref.startedAt > now
	)
		throw new NonRetriableError(
			'StragglerOwner: invalid original chain clock or attempt',
		)
	if (!ref.generation && (!owner || owner.state === 'complete'))
		owner = {
			generation: randomUUID(),
			state: 'active',
			startedAt: ref.startedAt,
			deadline: ref.startedAt + STRAGGLER_PARK_AFTER_MS,
			next: 1,
			...(membershipDigest && { membershipDigest }),
		}
	if (!owner)
		throw new NonRetriableError(
			'StragglerOwner: continuation has no original owner',
		)
	const answer = (status: Decision['status']) => ({
		owner: owner!,
		value: { status, owner: owner!, now },
	})
	if (ref.generation && owner.generation !== ref.generation)
		return answer('stale')
	if (owner.state !== 'active') return answer('joined')
	// Joined membership is not the original chain's alert provenance (PR2).
	if (!ref.generation && owner.next !== 1) return answer('joined')
	if (now >= owner.deadline) {
		owner = { ...owner, state: 'parked' }
		return answer('parked')
	}
	if (!ref.generation && attempt !== 1)
		throw new NonRetriableError(
			'StragglerOwner: a new starter must begin at attempt one',
		)
	if (attempt !== owner.next) return answer('joined')
	owner = { ...owner, next: attempt + 1 }
	return answer('claimed')
}
class OwnerStopped extends Error {
	constructor(readonly decision: Decision) {
		super('StragglerOwner: original owner no longer permits retry')
	}
}
type LegacyArgs = Parameters<typeof runContactSyncStragglerRetry>[0]
/** New starters only. No change to old event bodies, SDK steps or histories. */
export async function runOwnedStragglerRetry(
	args: LegacyArgs & {
		store: StragglerOwnerStore
		run: (args: LegacyArgs) => ReturnType<typeof runContactSyncStragglerRetry>
		parked: (fields: Record<string, unknown>) => Promise<unknown>
		joined?: (counts: Record<string, number>) => Promise<unknown>
	},
) {
	const { items, attempt, stragglerOwner: ref } = args.event.data
	if (!Object.hasOwn(args.event.data, 'stragglerOwner')) return args.run(args)
	if (!ref || typeof ref !== 'object')
		throw new NonRetriableError('StragglerOwner: malformed protocol marker')
	const contacts = [...new Set(items.map((item) => item.event.contactId))]
	if (
		ref.protocol !== 1 ||
		contacts.length !== 1 ||
		typeof contacts[0] !== 'string' ||
		contacts[0].includes('@') ||
		(args.event.data.acknowledge &&
			args.event.data.acknowledge.contactId !== contacts[0])
	)
		throw new NonRetriableError(
			'StragglerOwner: new starters require exactly one contact',
		)
	const contactId = contacts[0]!,
		key = stragglerOwnerKey(contactId)
	const keys = [
		...new Set(items.map((item) => item.event.idempotencyKey)),
	].sort()
	const membershipDigest = createHash('sha256')
		.update(JSON.stringify(keys))
		.digest('hex')
	const claim = (await args.step.run('straggler-owner-claim', () =>
		args.store.update(key, (owner, now) =>
			claimStragglerOwner(owner, ref, attempt, now, membershipDigest),
		),
	)) as Decision
	const stop = async (decision: Decision) => {
		if (decision.status !== 'parked') return { status: decision.status }
		await args.step.run('straggler-owner-alert', () =>
			args.parked({
				alertId: `straggler-parked:${decision.owner.generation}`,
				contactId,
				refusalCode: [...new Set(items.map((item) => item.reason))]
					.sort()
					.join(','),
				eventTypes: [...new Set(items.map((item) => item.event.type))].sort(),
				attempts: decision.owner.next - 1,
				firstAttemptAt: new Date(decision.owner.startedAt).toISOString(),
				parkedAt: new Date(decision.now).toISOString(),
			}),
		)
		return { status: 'parked' as const }
	}
	if (claim.status === 'joined' && !ref.generation && args.joined)
		await args.step.run('straggler-owner-joined-count', () =>
			args.joined!({
				starters: 1,
				incomingKeys: keys.length,
				unchangedMembership: Number(
					claim.owner.membershipDigest === membershipDigest,
				),
				changedMembershipCandidate: Number(
					!!claim.owner.membershipDigest &&
						claim.owner.membershipDigest !== membershipDigest,
				),
				unknownMembership: Number(!claim.owner.membershipDigest),
				parkedOwners: Number(claim.owner.state === 'parked'),
			}),
		)
	if (claim.status !== 'claimed') return stop(claim)
	// The memoized claim is not fresh permission on a delayed SDK retry.
	const fresh = async () => {
		const decision = await args.store.update(key, (owner, now) => {
			if (!owner) throw new Error('StragglerOwner: original owner disappeared')
			let status: Decision['status'] = 'stale'
			if (
				owner.generation === claim.owner.generation &&
				owner.state === 'active' &&
				owner.next === attempt + 1
			) {
				status = now >= owner.deadline ? 'parked' : 'claimed'
				if (status === 'parked') owner = { ...owner, state: 'parked' }
			}
			return { owner, value: { status, owner, now } }
		})
		return decision
	}
	let result: Awaited<ReturnType<typeof runContactSyncStragglerRetry>>
	try {
		result = await args.run({
			...args,
			step: {
				run: async (id, callback) => {
					if (
						!['deliver', 'birth-directory', 'redeliver-after-birth'].includes(
							id,
						)
					)
						return args.step.run(id, callback)
					// Persist a denial as DATA, not an Error subclass whose identity
					// the SDK can serialize away. Never treat cached success as POST permission.
					const saved = (await args.step.run(id, async () => {
						const decision = await fresh()
						return decision.status === 'claimed'
							? { kind: 'value', value: await callback() }
							: { kind: 'owner-stopped', decision }
					})) as
						| { kind: 'value'; value: unknown }
						| { kind: 'owner-stopped'; decision: Decision }
					if (saved.kind === 'owner-stopped')
						throw new OwnerStopped(saved.decision)
					if (saved.kind !== 'value')
						throw new NonRetriableError(
							'StragglerOwner: malformed retained step result',
						)
					return saved.value
				},
				sendEvent: (id, payload) => {
					const next = payload as DrovrContactSyncRetryRequested & {
						id: string
						ts: number
					}
					return args.step.sendEvent(id, {
						...next,
						id: `contact-sync-owned:${claim.owner.generation}:${next.data.attempt}`,
						ts: Math.min(next.ts, claim.owner.deadline),
						data: {
							...next.data,
							stragglerOwner: {
								protocol: 1,
								generation: claim.owner.generation,
								startedAt: claim.owner.startedAt,
							},
						},
					})
				},
			},
		})
	} catch (error) {
		if (error instanceof OwnerStopped) return stop(error.decision)
		throw error
	}
	if (result.status === 'delivered')
		await args.step.run('straggler-owner-complete', () =>
			args.store.update(key, (owner, now) => {
				if (!owner) throw new Error('StragglerOwner: completion lost owner')
				return {
					owner:
						owner.generation === claim.owner.generation &&
						owner.state === 'active'
							? { ...owner, state: 'complete' }
							: owner,
					value: now,
				}
			}),
		)
	return result
}
