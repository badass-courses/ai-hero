import {
	decodeHeldBatchContinuation,
	encodeHeldBatchContinuation,
	HeldBatchContinuationError,
} from './contact-sync-held-batch'
import {
	prepareHeldBatchReplay,
	type HeldBatchReplayPorts,
} from './contact-sync-held-batch-replay'
import type { HeldBatchPersistence } from './contact-sync-held-batch-persistence'
import type { DrovrOutboxRow } from './drovr-outbox'
import { heldBatchPinState } from './contact-sync-held-batch-pins'

export const HELD_BATCH_RELEASE_CONFIRMATION =
	'RELEASE ORIGINAL HELD BATCH AFTER CHECKING SDK RUNS'
export type HeldBatchReleaseWrite = {
	anchor: { target: string; key: string }
	previous: string
	encoded: string
	/** Scheduling clock only, never copied into bodies or originalClock. */
	now: string
}
export type HeldBatchReleasePersistence = HeldBatchPersistence & {
	release: (args: HeldBatchReleaseWrite) => Promise<boolean>
	/** Coordinator metadata only; never a receiver/delivery receipt. */
	finish: (args: {
		anchor: { target: string; key: string }
		previous: string
		encoded: string
	}) => Promise<boolean>
}

/** Read-only preflight. The caller must CAS the encoded permission before
 * publishing anything. Cancel/save old SDK runs before confirming release. */
export async function planHeldBatchRelease(args: {
	row: DrovrOutboxRow
	expectedEncoded: string
	confirmation: string
	releaseId: string
	now?: number
	rows: HeldBatchReplayPorts['rows']
}) {
	const fail = (reason: string) => new HeldBatchContinuationError({ reason })
	if (args.confirmation !== HELD_BATCH_RELEASE_CONFIRMATION)
		throw fail(
			'explicit operator confirmation after checking SDK runs is required',
		)
	if (args.row.heldBatch !== args.expectedEncoded)
		throw fail('the inspected encoded state changed; no permission was written')
	const previous = decodeHeldBatchContinuation(args.expectedEncoded)
	if (previous.completion.state === 'completed')
		throw fail(
			'the logical coordinator is completed and cannot be released again',
		)
	if (
		previous.target !== args.row.target ||
		previous.anchorKey !== args.row.dedupeKey
	)
		throw fail(
			'the inspected continuation belongs to a different target or anchor',
		)
	if (
		!args.row.heldBatchBlocked &&
		args.row.status !== 'held' &&
		previous.release.state !== 'held'
	)
		throw fail(
			'this permission is already released; inspect existing SDK/publication receipts instead of minting a duplicate release',
		)
	const encoded = encodeHeldBatchContinuation({
		...previous,
		release: { state: 'released', id: args.releaseId },
	})
	const proposed: DrovrOutboxRow = {
		...args.row,
		heldBatch: encoded,
		heldBatchBlocked: false,
		status:
			args.row.status === 'held' || args.row.status === 'deferred'
				? 'pending'
				: args.row.status,
	}
	const plan = await prepareHeldBatchReplay(proposed, {
		// A rejected preflight leaves the CURRENT held state untouched.
		block: async () => true,
		rows: async (target, keys) =>
			(await args.rows(target, keys)).map((row) =>
				row.dedupeKey === proposed.dedupeKey
					? {
							...row,
							heldBatch: encoded,
							heldBatchBlocked: false,
							status: proposed.status,
						}
					: row,
			),
	})
	if (!plan || plan.kind !== 'retry')
		throw fail(
			'the inspected members do not form a releasable immutable continuation',
		)
	return {
		encoded,
		request: plan.request,
		pinState: heldBatchPinState(previous, args.now ?? Date.now()),
	}
}
