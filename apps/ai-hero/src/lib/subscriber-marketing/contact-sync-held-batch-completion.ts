import {
	decodeHeldBatchContinuation,
	encodeHeldBatchContinuation,
	HeldBatchContinuationError,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'
import type { HeldBatchAnchor } from './contact-sync-held-batch-persistence'
import type { HeldBatchReleasePersistence } from './contact-sync-held-batch-release'
import {
	prepareHeldBatchReplay,
	type HeldBatchReplayPorts,
} from './contact-sync-held-batch-replay'

export const HELD_BATCH_ABANDON_CONFIRMATION =
	'ABANDON HELD BATCH AFTER CANCELLING SDK RUNS'
type Store = Pick<HeldBatchReleasePersistence, 'read' | 'block' | 'finish'>
const fail = (reason: string) => new HeldBatchContinuationError({ reason })
async function retained(anchor: HeldBatchAnchor, store: Store) {
	const state = await store.read(anchor)
	if (!state || state.invalid || typeof state.encoded !== 'string')
		throw fail(
			'the retained coordinator cannot be read for completion; evidence remains pinned',
		)
	const root = decodeHeldBatchContinuation(state.encoded)
	if (root.target !== anchor.target || root.anchorKey !== anchor.key)
		throw fail('the completion scope does not match its retained coordinator')
	return { root, previous: state.encoded }
}
async function finish(
	anchor: HeldBatchAnchor,
	root: HeldBatchContinuation,
	previous: string,
	reason: 'delivered' | 'terminal-rejected' | 'abandoned',
	at: string,
	store: Store,
) {
	const encoded = encodeHeldBatchContinuation({
		...root,
		completion: { state: 'completed', reason, at },
	})
	if (!(await store.finish({ anchor, previous, encoded })))
		throw fail(
			'a newer permission or completion replaced this snapshot; its state was not overwritten',
		)
	return { status: 'completed' as const, reason }
}

/** Explicit logical abandonment is NOT acceptance, a profile ACK, or removal
 * of the underlying native stop/birth debt. It only ends this batch's pins. */
export async function abandonHeldBatch(args: {
	anchor: HeldBatchAnchor
	expectedEncoded: string
	confirmation: string
	at: string
	store: Store
}) {
	if (args.confirmation !== HELD_BATCH_ABANDON_CONFIRMATION)
		throw fail(
			'explicit abandonment after cancelling and saving the original SDK runs is required',
		)
	const { root, previous } = await retained(args.anchor, args.store)
	if (previous !== args.expectedEncoded)
		throw fail('the inspected permission changed before abandonment')
	if (root.completion.state === 'completed')
		return { status: 'already-completed' as const }
	return finish(args.anchor, root, previous, 'abandoned', args.at, args.store)
}

/** Call ONLY after the whole logical batch and its ACK/refresh obligations
 * finish. Re-read first bodies/dispositions; phase/rejection metadata is never
 * receiver proof. No native status, body, clock or statistic is rewritten. */
export async function completeHeldBatch(args: {
	anchor: HeldBatchAnchor
	releaseId: string
	at: string
	store: Store
	rows: HeldBatchReplayPorts['rows']
}) {
	const { root, previous } = await retained(args.anchor, args.store)
	if (root.completion.state === 'completed')
		return { status: 'already-completed' as const }
	if (root.release.state !== 'released' || root.release.id !== args.releaseId)
		throw fail('a newer held/released permission owns completion')
	const rows = await args.rows(
		root.target,
		root.members.map((member) => member.key),
	)
	const anchor = rows.find((row) => row.dedupeKey === root.anchorKey)
	if (!anchor || anchor.heldBatch !== previous)
		throw fail('the coordinator changed during fresh completion proof')
	const plan = await prepareHeldBatchReplay(anchor, {
		rows: async () => rows,
		block: (scope, reason, expected) =>
			args.store.block(scope, reason, expected),
	})
	if (
		!plan ||
		plan.kind !== 'retry' ||
		rows.some(
			(row) =>
				row.heldBatchBlocked ||
				!['delivered', 'rejected', 'superseded'].includes(row.status),
		)
	)
		throw fail(
			'one or more logical members have no fresh terminal disposition; their evidence remains pinned',
		)
	return finish(
		args.anchor,
		root,
		previous,
		rows.some((row) => row.status === 'rejected')
			? 'terminal-rejected'
			: 'delivered',
		args.at,
		args.store,
	)
}
