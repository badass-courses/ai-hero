import {
	decodeHeldBatchContinuation,
	HELD_BATCH_PIN_MAX_AGE_MS,
	HeldBatchContinuationError,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'

/** Overflow refuses the purge; it never truncates the set of references. */
export const HELD_BATCH_PIN_SCAN_MAX_COORDINATORS = 256
export type HeldBatchPinRecord = {
	target: string
	key: string
	encoded: unknown
}
export const heldBatchPinKey = (target: string, key: string) =>
	`${target}:${key}`

/** Used inside the purge transaction AFTER its current locking pin read. */
export function unpinnedDeliveredCandidates<
	T extends { target: string; dedupeKey: string },
>(rows: readonly T[], pins: ReadonlySet<string>): T[] {
	return rows.filter(
		(row) => !pins.has(heldBatchPinKey(row.target, row.dedupeKey)),
	)
}

export function heldBatchPinState(
	root: Pick<HeldBatchContinuation, 'parkedAt' | 'completion'>,
	now: number,
): 'active' | 'pin-expired' | 'completed' {
	if (!Number.isFinite(now))
		throw new HeldBatchContinuationError({
			reason: 'the pin inspection clock is invalid; evidence cannot be purged',
		})
	if (root.completion.state === 'completed') return 'completed'
	return now >= Date.parse(root.parkedAt) + HELD_BATCH_PIN_MAX_AGE_MS
		? 'pin-expired'
		: 'active'
}

/** Pins survive expiry. Only a terminal marker ends the pin; expiry requires
 * operator release or explicit abandonment, never silent deletion. */
export function collectHeldBatchPins(
	records: readonly HeldBatchPinRecord[],
	now: number,
): {
	pinned: ReadonlySet<string>
	members: readonly { target: string; key: string }[]
	expired: readonly HeldBatchPinRecord[]
} {
	if (records.length > HELD_BATCH_PIN_SCAN_MAX_COORDINATORS)
		throw new HeldBatchContinuationError({
			reason:
				'the bounded coordinator scan overflowed; no delivered evidence may be deleted until operator inspection or the dedicated-column migration',
		})
	const pinned = new Set<string>()
	const members: { target: string; key: string }[] = []
	const expired: HeldBatchPinRecord[] = []
	for (const record of records) {
		if (typeof record.encoded !== 'string')
			throw new HeldBatchContinuationError({
				reason:
					'an unfinished coordinator has invalid or incomplete diagnostic state; purge is refused rather than losing unknown references',
			})
		const root = decodeHeldBatchContinuation(record.encoded)
		if (root.target !== record.target || root.anchorKey !== record.key)
			throw new HeldBatchContinuationError({
				reason:
					'a coordinator pin does not match its retained target and anchor; purge is refused',
			})
		const state = heldBatchPinState(root, now)
		if (state === 'completed') continue
		if (state === 'pin-expired') expired.push(record)
		for (const member of root.members) {
			const key = heldBatchPinKey(root.target, member.key)
			if (!pinned.has(key))
				members.push({ target: root.target, key: member.key })
			pinned.add(key)
		}
	}
	return { pinned, members, expired }
}
