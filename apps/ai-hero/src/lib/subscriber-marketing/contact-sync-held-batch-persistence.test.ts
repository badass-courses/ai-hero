import { describe, expect, it, vi } from 'vitest'
import {
	encodeHeldBatchContinuation,
	HELD_BATCH_MAX_REFERENCES,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'
import {
	parkHeldBatchContinuation,
	type HeldBatchPersistence,
} from './contact-sync-held-batch-persistence'

const key = 'a'.repeat(64)
const anchor = { target: 'synthetic-target', key }
const releaseId = '00000000-0000-4000-8000-000000000001'
const value = (): HeldBatchContinuation => ({
	v: 1,
	release: { state: 'held' },
	target: anchor.target,
	anchorKey: key,
	source: 'contact-profile-sync',
	class: 'delta',
	originalClock: '2032-01-01T00:00:00.000Z',
	parkedAt: '2032-01-02T00:00:00.000Z',
	completion: { state: 'unfinished' },
	attempt: 1,
	rejectedCarry: 0,
	acknowledge: { contactId: 'synthetic-contact', profileVersion: 3 },
	members: [{ key, phase: 'pending', reason: 'event-not-live' }],
})
function fixture(encoded: unknown = undefined) {
	const state: {
		encoded: unknown
		status: 'pending' | 'held' | 'delivered' | 'superseded'
		blocked: boolean
		reasons: string[]
	} = { encoded, status: 'pending', blocked: false, reasons: [] }
	const store: HeldBatchPersistence = {
		block: vi.fn(async (_anchor, reason) => {
			if (state.status === 'delivered') return false
			state.blocked = true
			if (state.status === 'pending') state.status = 'held'
			state.reasons.push(reason)
			return true
		}),
		read: vi.fn(async () => ({ encoded: state.encoded })),
		put: vi.fn(async ({ previous, encoded }) => {
			if (state.encoded !== previous) return false
			state.encoded = encoded
			return true
		}),
	}
	return { state, store }
}
const park = (
	store: HeldBatchPersistence,
	continuation: unknown = value(),
	id?: string,
) =>
	parkHeldBatchContinuation({
		anchor,
		value: continuation,
		reason: 'synthetic owed work, not acceptance',
		releaseId: id,
		store,
	})

describe('durable held-batch persistence ordering', () => {
	it('blocks before decoding and saves only versioned references, without publication or acknowledgement', async () => {
		const { state, store } = fixture()
		expect(await park(store)).toEqual(value())
		expect(state.blocked).toBe(true)
		expect(state.status).toBe('held')
		expect(typeof state.encoded).toBe('string')
		expect(state.encoded).not.toContain('payload')
		expect(state.encoded).not.toContain('body')
		expect(vi.mocked(store.block).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(store.read).mock.invocationCallOrder[0]!,
		)
		expect(vi.mocked(store.read).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(store.put).mock.invocationCallOrder[0]!,
		)
	})
	it('holds an over-count request with its literal cap reason and saves no truncated continuation', async () => {
		const { state, store } = fixture()
		const oversized = {
			...value(),
			members: Array.from(
				{ length: HELD_BATCH_MAX_REFERENCES + 1 },
				(_, i) => ({
					key: i.toString(16).padStart(64, '0'),
					phase: 'pending',
					reason: 'event-not-live',
				}),
			),
		}
		oversized.anchorKey = oversized.members[0]!.key
		const before = JSON.stringify(oversized)
		await expect(
			parkHeldBatchContinuation({
				anchor: { ...anchor, key: oversized.anchorKey },
				value: oversized,
				reason: 'synthetic count test',
				store,
			}),
		).rejects.toThrow(/HeldBatchContinuation:/)
		expect(state.status).toBe('held')
		expect(state.blocked).toBe(true)
		expect(state.reasons.at(-1)).toContain(
			`${HELD_BATCH_MAX_REFERENCES} members`,
		)
		expect(store.put).not.toHaveBeenCalled()
		expect(state.encoded).toBeUndefined()
		expect(JSON.stringify(oversized)).toBe(before)
	})
	it.each(['{', JSON.stringify({ v: 2 }), null, 1])(
		'keeps malformed previous state intact and blocked: %j',
		async (encoded) => {
			const { state, store } = fixture(encoded)
			await expect(park(store)).rejects.toThrow(/HeldBatchContinuation:/)
			expect(state.encoded).toBe(encoded)
			expect(state.blocked).toBe(true)
			expect(store.put).not.toHaveBeenCalled()
		},
	)
	it('accepts an exact repeat but never silently overwrites another parked source', async () => {
		const { state, store } = fixture(encodeHeldBatchContinuation(value()))
		await park(store)
		const original = state.encoded
		await expect(
			park(store, {
				...value(),
				source: 'contact-profile-restate',
				class: 'restate',
			}),
		).rejects.toThrow(/different parked scope or release/)
		expect(state.encoded).toBe(original)
		expect(state.blocked).toBe(true)
	})
	it('only the matching explicit release can re-park advanced bookkeeping for the same immutable scope', async () => {
		const released = {
			...value(),
			release: { state: 'released', id: releaseId },
		}
		const { state, store } = fixture(encodeHeldBatchContinuation(released))
		const next = { ...value(), attempt: 2 }
		await expect(
			park(store, next, '00000000-0000-4000-8000-000000000002'),
		).rejects.toThrow(/different parked scope or release/)
		expect(state.encoded).toBe(encodeHeldBatchContinuation(released))
		await expect(park(store, next, releaseId)).resolves.toEqual(next)
		expect(state.encoded).toBe(encodeHeldBatchContinuation(next))
	})
	it('an operator release is not permission to rebase the original clock', async () => {
		const original = encodeHeldBatchContinuation({
			...value(),
			release: { state: 'released', id: releaseId },
		})
		const { state, store } = fixture(original)
		await expect(
			park(
				store,
				{ ...value(), originalClock: '2032-01-01T00:00:00.001Z' },
				releaseId,
			),
		).rejects.toThrow(/different parked scope or release/)
		expect(state.encoded).toBe(original)
		expect(state.blocked).toBe(true)
	})
	it('a concurrent metadata write survives a failed compare-and-set', async () => {
		const { state, store } = fixture()
		store.put = vi.fn(async () => {
			state.encoded = 'synthetic-newer-state'
			return false
		})
		await expect(park(store)).rejects.toThrow(/compare-and-set/)
		expect(state.encoded).toBe('synthetic-newer-state')
		expect(state.blocked).toBe(true)
	})
	it('does not rewrite a delivered anchor, even to record a validation error', async () => {
		const { state, store } = fixture()
		state.status = 'delivered'
		await expect(park(store, { v: 2 })).rejects.toThrow(
			/closed delivery history was not rewritten/,
		)
		expect(state.status).toBe('delivered')
		expect(state.blocked).toBe(false)
		expect(store.read).not.toHaveBeenCalled()
		expect(store.put).not.toHaveBeenCalled()
	})
	it('holding a coordinator on a superseded unsubscribe never revives the unsubscribe', async () => {
		const { state, store } = fixture()
		state.status = 'superseded'
		await park(store)
		expect(state.status).toBe('superseded')
		expect(state.blocked).toBe(true)
		expect(state.encoded).toBe(encodeHeldBatchContinuation(value()))
	})
})
