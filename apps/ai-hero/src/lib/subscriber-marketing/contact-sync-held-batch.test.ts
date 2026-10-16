import * as fc from 'effect/FastCheck'
import { describe, expect, it } from 'vitest'
import {
	decodeHeldBatchContinuation,
	encodeHeldBatchContinuation,
	HELD_BATCH_MAX_ENCODED_BYTES,
	HELD_BATCH_MAX_REFERENCES,
	HeldBatchContinuationError,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'

const reference = (index: number) => ({
	key: index.toString(16).padStart(64, '0'),
	phase: 'pending' as const,
	reason: 'event-not-live' as const,
})
const batch = (): HeldBatchContinuation => ({
	v: 1,
	release: { state: 'held' },
	target: 'synthetic-target',
	anchorKey: reference(0).key,
	source: 'contact-profile-sync',
	class: 'delta',
	originalClock: '2032-01-01T00:00:00.000Z',
	parkedAt: '2032-01-02T00:00:00.000Z',
	completion: { state: 'unfinished' },
	attempt: 7,
	rejectedCarry: 0,
	acknowledge: { contactId: 'synthetic-contact', profileVersion: 3 },
	members: [reference(0)],
})

describe('HeldBatchContinuation v1 boundary', () => {
	it('round trips scoped references, acknowledgement, provenance and the exact original clock, without bodies', () => {
		const value = batch()
		const encoded = encodeHeldBatchContinuation(value)
		expect(decodeHeldBatchContinuation(encoded)).toEqual(value)
		expect(encoded).not.toContain('body')
		expect(encoded).not.toContain('payload')
	})

	it.each([
		{ v: 2 },
		{ release: { state: 'released' } },
		{ release: { state: 'released', id: '-'.repeat(36) } },
		{ release: { state: 'held', id: '00000000-0000-4000-8000-000000000000' } },
		{ anchorKey: 'unscoped-wire-key' },
		{ originalClock: '2032-02-30T00:00:00.000Z' },
		{ originalClock: '2032-01-01T01:00:00.000+01:00' },
		{ class: 'live' },
		{ attempt: 0 },
		{ rejectedCarry: -1 },
		{ members: [] },
		{ members: [reference(1)] },
		{ members: [reference(0), reference(0)] },
		{ members: [{ ...reference(0), body: { synthetic: true } }] },
		{ body: { synthetic: true } },
	])(
		'rejects invalid state rather than stripping or inferring fields: %j',
		(patch) => {
			const encoded = JSON.stringify({ ...batch(), ...patch })
			expect(() => decodeHeldBatchContinuation(encoded)).toThrow(
				HeldBatchContinuationError,
			)
			expect(() => decodeHeldBatchContinuation(encoded)).toThrow(
				/no HTTP attempt or acknowledgement is authorized/,
			)
		},
	)

	it('allows the exact reference cap and rejects cap+1 without truncating the input', () => {
		const value = {
			...batch(),
			members: Array.from({ length: HELD_BATCH_MAX_REFERENCES }, (_, i) =>
				reference(i),
			),
		}
		expect(
			decodeHeldBatchContinuation(encodeHeldBatchContinuation(value)).members,
		).toHaveLength(HELD_BATCH_MAX_REFERENCES)
		value.members.push(reference(HELD_BATCH_MAX_REFERENCES))
		const before = JSON.stringify(value)
		expect(() => encodeHeldBatchContinuation(value)).toThrow(
			HeldBatchContinuationError,
		)
		expect(JSON.stringify(value)).toBe(before)
	})

	it('bounds encoded bytes before JSON parsing, even for otherwise valid padded state', () => {
		const encoded = encodeHeldBatchContinuation(batch())
		const atLimit =
			encoded +
			' '.repeat(HELD_BATCH_MAX_ENCODED_BYTES - Buffer.byteLength(encoded))
		expect(decodeHeldBatchContinuation(atLimit)).toEqual(batch())
		expect(() => decodeHeldBatchContinuation(atLimit + ' ')).toThrow(
			/the encoded continuation exceeds the byte cap/,
		)
		expect(() => decodeHeldBatchContinuation('{')).toThrow(/not valid JSON/)
	})

	it('cannot downgrade capped sources or add a profile acknowledgement to a live offer continuation', () => {
		for (const source of [
			'contact-profile-restate',
			'kit-directory-ingest',
			'contact-sync-backfill',
			'evergreen-pitch-backfill',
		])
			expect(() =>
				encodeHeldBatchContinuation({ ...batch(), source, class: 'live' }),
			).toThrow(HeldBatchContinuationError)
		expect(() =>
			encodeHeldBatchContinuation({
				...batch(),
				source: 'live',
				class: 'live',
			}),
		).toThrow(HeldBatchContinuationError)
		const { acknowledge: _ack, ...withoutAck } = batch()
		expect(
			decodeHeldBatchContinuation(
				encodeHeldBatchContinuation({
					...withoutAck,
					source: 'live',
					class: 'live',
				}),
			).class,
		).toBe('live')
	})

	it('property: encoding never changes unique scoped member identities or original clock', () => {
		const key = fc
			.uint8Array({ minLength: 32, maxLength: 32 })
			.map((bytes) => Buffer.from(bytes).toString('hex'))
		fc.assert(
			fc.property(
				fc.uniqueArray(key, { minLength: 1, maxLength: 12 }),
				(keys) => {
					const value = {
						...batch(),
						anchorKey: keys[0],
						members: keys.map((key) => ({
							key,
							phase: 'pending',
							reason: 'event-not-live',
						})),
					}
					const decoded = decodeHeldBatchContinuation(
						encodeHeldBatchContinuation(value),
					)
					expect(decoded.members.map((member) => member.key)).toEqual(keys)
					expect(decoded.originalClock).toBe(value.originalClock)
				},
			),
			{ numRuns: 100, seed: 428 },
		)
	})
})
