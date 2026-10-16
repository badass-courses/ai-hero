import { describe, expect, it, vi } from 'vitest'
import { Either, Schema } from 'effect'
import { encodeHeldBatchContinuation } from './contact-sync-held-batch'
import {
	HeldContinuationEnvelope,
	OUTBOX_CONTROL_MAX_ENCODED_BYTES,
	encodeHeldContinuationEnvelope,
	missingHeldContinuationColumn,
	readHeldContinuationEnvelope,
	readWithHeldContinuationFallback,
	writeHeldContinuationGuard,
} from './drovr-outbox-control'
import { readOutboxQueueState } from './drovr-outbox-queue-state'
const warn = vi.hoisted(() => vi.fn(async (_tag: string, _data: unknown) => {}))
vi.mock('@/server/logger', () => ({ log: { warn } }))
const missing = () =>
	Object.assign(
		new Error(
			"Unknown column 'AI_DrovrOutbox.heldContinuation' in 'field list'",
		),
		{ errno: 1054, code: 'ER_BAD_FIELD_ERROR' },
	)
function batch() {
	return encodeHeldBatchContinuation({
		v: 1,
		release: { state: 'held' },
		target: 'synthetic-column-target',
		anchorKey: '0'.repeat(64),
		source: 'contact-profile-sync',
		class: 'delta',
		originalClock: '2032-01-01T00:00:00.000Z',
		parkedAt: '2032-01-01T00:00:00.000Z',
		completion: { state: 'unfinished' },
		attempt: 1,
		rejectedCarry: 0,
		members: Array.from({ length: 128 }, (_, n) => ({
			key: n.toString(16).padStart(64, '0'),
			phase: 'pending',
			reason: 'event-not-live',
		})),
	})
}

describe('versioned dedicated outbox control column', () => {
	it('keeps a full 128-reference encoded continuation byte-exact independently of replay proof', () => {
		const encoded = batch()
		const wire = encodeHeldContinuationEnvelope({
			v: 1,
			continuation: { v: 1, encoded, blocked: true },
			replayProof: { v: 1, handoffs: 7, publicationId: 'synthetic-claim' },
		})
		const decoded = readHeldContinuationEnvelope(wire)!
		expect(Buffer.from(decoded.continuation!.encoded!)).toEqual(
			Buffer.from(encoded),
		)
		expect(readOutboxQueueState(decoded, 'synthetic HTTP503')).toMatchObject({
			handoffs: 7,
			publicationId: 'synthetic-claim',
			heldBatch: encoded,
			heldBatchBlocked: true,
			diagnostic: 'synthetic HTTP503',
			invalid: false,
		})
	})
	it('nullable/missing state never interprets an error string as operational metadata', () => {
		const error = JSON.stringify({ v: 1, replayProof: { v: 1, handoffs: 8 } })
		expect(readOutboxQueueState(undefined, error)).toEqual({
			handoffs: 0,
			diagnostic: error,
			invalid: false,
		})
		expect(readHeldContinuationEnvelope(null)).toBeUndefined()
	})
	it.each([
		{ v: 2 },
		{ v: 1, replayProof: { v: 2, handoffs: 0 } },
		{ v: 1, replayProof: { v: 1, handoffs: -1 } },
		{ v: 1, replayProof: { v: 1, handoffs: Number.MAX_SAFE_INTEGER + 1 } },
		{
			v: 1,
			replayProof: { v: 1, handoffs: 0, publicationId: 'x'.repeat(129) },
		},
		{ v: 1, continuation: { v: 2, blocked: true } },
		{ v: 1, continuation: { v: 1, blocked: false } },
		{ v: 1, continuation: { v: 1, blocked: true, encoded: '{}' } },
		{ v: 1, body: { email: 'synthetic@example.test' } },
	])(
		'rejects malformed/foreign members without trimming or native-body fallback: %j',
		(value) => {
			expect(
				Either.isLeft(
					Schema.decodeUnknownEither(HeldContinuationEnvelope, {
						onExcessProperty: 'error',
					})(value),
				),
			).toBe(true)
			expect(() => encodeHeldContinuationEnvelope(value)).toThrow(
				/OutboxControl: you/,
			)
			expect(readOutboxQueueState(value)).toMatchObject({
				invalid: true,
				heldBatchBlocked: true,
			})
		},
	)
	it('rejects oversized encoded JSON before parsing rather than normalizing/trimming it', () => {
		expect(() =>
			readHeldContinuationEnvelope(
				' '.repeat(OUTBOX_CONTROL_MAX_ENCODED_BYTES) + '{"v":1}',
			),
		).toThrow(/exceeds its byte bound/)
	})
	it('classifies only the exact missing column, including wrapped driver causes', () => {
		expect(missingHeldContinuationColumn({ cause: missing() })).toBe(true)
		expect(
			missingHeldContinuationColumn({
				errno: 1054,
				message: "Unknown column 'otherColumn' in 'field list'",
			}),
		).toBe(false)
		expect(
			missingHeldContinuationColumn({
				errno: 1146,
				message: 'missing table heldContinuation',
			}),
		).toBe(false)
	})
	it('missing-column readers fall back with one log even when logging fails; writers never ACK/fall back', async () => {
		warn.mockRejectedValueOnce(new Error('synthetic logger outage'))
		const fallback = vi.fn(async () => 'no held state')
		for (let n = 0; n < 2; n++)
			await expect(
				readWithHeldContinuationFallback(async () => {
					throw missing()
				}, fallback),
			).resolves.toBe('no held state')
		const acknowledge = vi.fn()
		const legacyWrite = vi.fn()
		await expect(
			writeHeldContinuationGuard(async () => {
				throw missing()
			}),
		).rejects.toThrow(
			/no coordination, acknowledgement or legacy diagnostic fallback/,
		)
		expect(warn).toHaveBeenCalledOnce()
		expect(fallback).toHaveBeenCalledTimes(2)
		expect(acknowledge).not.toHaveBeenCalled()
		expect(legacyWrite).not.toHaveBeenCalled()
	})
	it('other schema errors are not hidden as an absent optional column', async () => {
		const error = Object.assign(new Error("Unknown column 'otherColumn'"), {
			errno: 1054,
		})
		const fallback = vi.fn(async () => null)
		await expect(
			readWithHeldContinuationFallback(async () => {
				throw error
			}, fallback),
		).rejects.toBe(error)
		expect(fallback).not.toHaveBeenCalled()
	})
})
