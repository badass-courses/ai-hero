import {
	decodeHeldBatchContinuation,
	encodeHeldBatchContinuation,
	HeldBatchContinuationError,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'

export type HeldBatchAnchor = { target: string; key: string }
export type HeldBatchPersistence = {
	/** Blocks first, preserving wire bytes, clocks, history and old metadata. */
	block: (
		anchor: HeldBatchAnchor,
		reason: string,
		expected?: { encoded?: unknown; releaseId?: string },
	) => Promise<boolean>
	read: (
		anchor: HeldBatchAnchor,
	) => Promise<{ encoded: unknown; invalid?: boolean } | undefined>
	/** Compare-and-set only this metadata field; never a post-publish lease. */
	put: (args: {
		anchor: HeldBatchAnchor
		previous: unknown
		encoded: string
	}) => Promise<boolean>
}

const failure = (reason: string) => new HeldBatchContinuationError({ reason })

/** A re-park may advance bookkeeping, never replace its immutable scope. */
export function sameHeldBatchScope(
	previous: HeldBatchContinuation,
	next: HeldBatchContinuation,
): boolean {
	return (
		previous.target === next.target &&
		previous.anchorKey === next.anchorKey &&
		previous.source === next.source &&
		previous.class === next.class &&
		previous.originalClock === next.originalClock &&
		previous.parkedAt === next.parkedAt &&
		previous.completion.state === 'unfinished' &&
		next.completion.state === 'unfinished' &&
		JSON.stringify(previous.acknowledge ?? null) ===
			JSON.stringify(next.acknowledge ?? null) &&
		previous.members.length === next.members.length &&
		previous.members.every((member) =>
			next.members.some((other) => member.key === other.key),
		) &&
		next.attempt >= previous.attempt &&
		next.rejectedCarry >= previous.rejectedCarry
	)
}

/**
 * The anchor is blocked BEFORE schema/count/byte decoding. A malformed or
 * oversized request therefore cannot accidentally leave publishable work.
 * No truncation, body snapshot, publication, acknowledgement or clock write.
 */
export async function parkHeldBatchContinuation(args: {
	anchor: HeldBatchAnchor
	value: unknown
	reason: string
	/** Only an explicitly released run may advance an existing parked record. */
	releaseId?: string
	store: HeldBatchPersistence
}): Promise<HeldBatchContinuation> {
	const permission = args.releaseId ? { releaseId: args.releaseId } : undefined
	if (!(await args.store.block(args.anchor, args.reason, permission)))
		throw failure(
			'the unfinished anchor could not be blocked; closed delivery history was not rewritten',
		)
	try {
		const loaded = await args.store.read(args.anchor)
		if (!loaded) throw failure('the blocked anchor is absent')
		if (loaded.invalid)
			throw failure(
				'the anchor diagnostic envelope is invalid; its previous state was retained',
			)
		const encoded = encodeHeldBatchContinuation(args.value)
		const next = decodeHeldBatchContinuation(encoded)
		if (
			next.target !== args.anchor.target ||
			next.anchorKey !== args.anchor.key ||
			next.release.state !== 'held' ||
			next.completion.state !== 'unfinished'
		)
			throw failure(
				'the continuation does not match its held target and anchor',
			)
		if (loaded.encoded !== undefined) {
			if (typeof loaded.encoded !== 'string')
				throw failure('the previous continuation is not encoded v1 state')
			const previous = decodeHeldBatchContinuation(loaded.encoded)
			if (loaded.encoded === encoded) return next
			if (loaded.encoded !== encoded) {
				if (
					previous.release.state !== 'released' ||
					previous.release.id !== args.releaseId ||
					!sameHeldBatchScope(previous, next)
				)
					throw failure(
						'a different parked scope or release owns this anchor; its original state was retained',
					)
			}
		}
		if (
			!(await args.store.put({
				anchor: args.anchor,
				previous: loaded.encoded,
				encoded,
			}))
		)
			throw failure(
				'the anchor metadata changed before its compare-and-set completed',
			)
		return next
	} catch (error) {
		const reported =
			error instanceof HeldBatchContinuationError
				? error
				: failure('the held continuation could not be validated or persisted')
		// Persist the literal reason too, without replacing the old encoded
		// scope. An over-limit request remains held, never silently truncated.
		await args.store.block(args.anchor, reported.message, permission)
		throw reported
	}
}
