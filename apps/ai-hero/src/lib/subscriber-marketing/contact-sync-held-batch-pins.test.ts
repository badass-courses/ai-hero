import { describe, expect, it } from 'vitest'
import {
	encodeHeldBatchContinuation,
	HELD_BATCH_PIN_MAX_AGE_MS,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'
import {
	collectHeldBatchPins,
	HELD_BATCH_PIN_SCAN_MAX_COORDINATORS,
	heldBatchPinKey,
	heldBatchPinState,
	unpinnedDeliveredCandidates,
} from './contact-sync-held-batch-pins'

const clock = '2032-01-01T00:00:00.000Z'
const at = Date.parse(clock)
const key = (n: number) => n.toString(16).padStart(64, '0')
function root(keys = [key(1), key(2)]): HeldBatchContinuation {
	return {
		v: 1,
		target: 'synthetic-pin-target',
		anchorKey: keys[0]!,
		source: 'contact-profile-sync',
		class: 'delta',
		originalClock: clock,
		parkedAt: clock,
		completion: { state: 'unfinished' },
		attempt: 1,
		rejectedCarry: 0,
		release: { state: 'held' },
		members: keys.map((key) => ({
			key,
			phase: 'pending',
			reason: 'event-not-live',
		})),
	}
}
const record = (value: HeldBatchContinuation) => ({
	target: value.target,
	key: value.anchorKey,
	encoded: encodeHeldBatchContinuation(value),
})

describe('held batch receipt lifetime', () => {
	it('changes exactly at 30 days into an operator signal, never an unpin', () => {
		const value = root()
		expect(heldBatchPinState(value, at + HELD_BATCH_PIN_MAX_AGE_MS - 1)).toBe(
			'active',
		)
		expect(heldBatchPinState(value, at + HELD_BATCH_PIN_MAX_AGE_MS)).toBe(
			'pin-expired',
		)
		const result = collectHeldBatchPins(
			[record(value)],
			at + HELD_BATCH_PIN_MAX_AGE_MS * 100,
		)
		expect(result.expired).toHaveLength(1)
		expect(result.pinned.has(heldBatchPinKey(value.target, key(1)))).toBe(true)
		expect(result.pinned.has(heldBatchPinKey(value.target, key(2)))).toBe(true)
	})
	it('explicit release does not rebase the first park or end the evidence pin', () => {
		const value: HeldBatchContinuation = {
			...root(),
			release: {
				state: 'released',
				id: '00000000-0000-4000-8000-000000000001',
			},
		}
		const pins = collectHeldBatchPins(
			[record(value)],
			at + HELD_BATCH_PIN_MAX_AGE_MS,
		)
		expect(pins.expired).toHaveLength(1)
		expect(pins.pinned.size).toBe(2)
	})
	it.each(['delivered', 'terminal-rejected', 'abandoned'] as const)(
		'completion %s permits the next normal purge pass, never fake receiver acceptance',
		(reason) => {
			const value = root()
			const rows = value.members.map((member) => ({
				target: value.target,
				dedupeKey: member.key,
			}))
			expect(
				unpinnedDeliveredCandidates(
					rows,
					collectHeldBatchPins([record(value)], at).pinned,
				),
			).toEqual([])
			const completed: HeldBatchContinuation = {
				...value,
				completion: { state: 'completed', at: clock, reason },
			}
			expect(heldBatchPinState(completed, at + HELD_BATCH_PIN_MAX_AGE_MS)).toBe(
				'completed',
			)
			expect(
				unpinnedDeliveredCandidates(
					rows,
					collectHeldBatchPins([record(completed)], at).pinned,
				),
			).toEqual(rows)
		},
	)
	it('one completed coordinator cannot remove another unfinished coordinator’s shared pin', () => {
		const first = root()
		const second: HeldBatchContinuation = {
			...root([key(2), key(3)]),
			completion: { state: 'completed', at: clock, reason: 'abandoned' },
		}
		const pins = collectHeldBatchPins(
			[record(first), record(second)],
			at,
		).pinned
		expect(pins.has(heldBatchPinKey(first.target, key(2)))).toBe(true)
		expect(pins.has(heldBatchPinKey(first.target, key(3)))).toBe(false)
	})
	it('target scope is part of the pin, never a bare wire/member key', () => {
		const value = root()
		const pins = collectHeldBatchPins([record(value)], at).pinned
		const other = { target: 'synthetic-other-target', dedupeKey: key(1) }
		expect(unpinnedDeliveredCandidates([other], pins)).toEqual([other])
	})
	it('property: no member referenced by ANY unfinished coordinator is deleted, including after expiry', () => {
		// Reproducible generated cases without adding a package/lockfile dependency.
		let seed = 0x41c0ffee
		const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
		for (let trial = 0; trial < 250; trial++) {
			const start = next() % 1000
			const ids = Array.from(
				{ length: ((next() >>> 8) % 64) + 1 },
				(_, index) => ((start + index * 7) % 1000) + 1,
			)
			const released = ((next() >>> 7) & 1) === 1
			const days = next() % 101
			const value: HeldBatchContinuation = {
				...root(ids.map(key)),
				release: released
					? { state: 'released', id: '00000000-0000-4000-8000-000000000001' }
					: { state: 'held' },
			}
			const rows = [
				...value.members.map((member) => ({
					target: value.target,
					dedupeKey: member.key,
				})),
				{ target: value.target, dedupeKey: key(1001) },
			]
			const selected = unpinnedDeliveredCandidates(
				rows,
				collectHeldBatchPins([record(value)], at + days * 86_400_000).pinned,
			)
			expect(
				selected,
				`seed=0x41c0ffee trial=${trial} days=${days} released=${released}`,
			).toEqual([{ target: value.target, dedupeKey: key(1001) }])
		}
	})
	it('invalid/missing metadata, scope mismatch and scan overflow refuse purge instead of truncating', () => {
		const valid = record(root())
		for (const invalid of [undefined, '{', '{}'])
			expect(() =>
				collectHeldBatchPins([{ ...valid, encoded: invalid }], at),
			).toThrow(/HeldBatchContinuation:/)
		expect(() =>
			collectHeldBatchPins([{ ...valid, target: 'synthetic-other' }], at),
		).toThrow(/retained target/)
		expect(() =>
			collectHeldBatchPins(
				Array.from(
					{ length: HELD_BATCH_PIN_SCAN_MAX_COORDINATORS + 1 },
					() => valid,
				),
				at,
			),
		).toThrow(/overflowed/)
		expect(() => collectHeldBatchPins([valid], NaN)).toThrow(/clock/)
	})
})
