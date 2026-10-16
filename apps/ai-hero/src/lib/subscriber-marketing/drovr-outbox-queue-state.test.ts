import { describe, expect, it } from 'vitest'
import { readOutboxQueueState } from './drovr-outbox-queue-state'
import { encodeHeldBatchContinuation } from './contact-sync-held-batch'
const clock = '2032-01-01T00:00:00.000Z'
const encoded = () =>
	encodeHeldBatchContinuation({
		v: 1,
		target: 'synthetic-queue-target',
		anchorKey: 'a'.repeat(64),
		source: 'contact-profile-sync',
		class: 'delta',
		originalClock: clock,
		parkedAt: clock,
		completion: { state: 'unfinished' },
		release: { state: 'held' },
		attempt: 1,
		rejectedCarry: 0,
		members: [
			{ key: 'a'.repeat(64), phase: 'pending', reason: 'event-not-live' },
		],
	})

describe('held coordinator and replay members in the dedicated JSON column', () => {
	it('keeps the encoded continuation independent of the HTTP diagnostic and publication proof', () => {
		const batch = encoded()
		const value = {
			v: 1,
			replayProof: { v: 1, handoffs: 3, publicationId: 'synthetic-claim' },
			continuation: {
				v: 1,
				encoded: batch,
				blocked: true,
				reason: 'synthetic manual review',
			},
		}
		expect(
			readOutboxQueueState(JSON.stringify(value), 'synthetic HTTP503'),
		).toEqual({
			handoffs: 3,
			publicationId: 'synthetic-claim',
			diagnostic: 'synthetic HTTP503',
			invalid: false,
			heldBatch: batch,
			heldBatchBlocked: true,
			heldBatchReason: 'synthetic manual review',
		})
	})
	it.each([
		{ encoded: 123 },
		{ encoded: null },
		{ blocked: 'false' },
		{ blocked: false },
		{ reason: 17 },
		{ reason: 'x'.repeat(2049) },
	])('fails closed on malformed held control, not a release: %j', (extra) => {
		expect(
			readOutboxQueueState(
				{ v: 1, continuation: { v: 1, ...extra } },
				'synthetic original',
			),
		).toMatchObject({
			invalid: true,
			heldBatchBlocked: true,
			diagnostic: 'synthetic original',
		})
	})
	it('never downgrades an unknown control version to a historical plain diagnostic', () => {
		expect(
			readOutboxQueueState(
				{ v: 2, continuation: { encoded: encoded() } },
				'synthetic original',
			),
		).toEqual({
			handoffs: 0,
			diagnostic: 'synthetic original',
			invalid: true,
			heldBatchBlocked: true,
		})
	})
})

describe('outbox replay proof decoder', () => {
	it.each([null, 'synthetic HTTP503', '{"type":"synthetic-problem"}', 'null'])(
		'retains a historical diagnostic without inventing handoffs: %s',
		(diagnostic) => {
			expect(readOutboxQueueState(null, diagnostic)).toEqual({
				diagnostic,
				handoffs: 0,
				invalid: false,
			})
		},
	)
	it('reads the distinct handoff count and leaves the exact diagnostic intact', () => {
		const diagnostic = 'synthetic first failure\nwith "quoted" detail'
		expect(
			readOutboxQueueState(
				{ v: 1, replayProof: { v: 1, handoffs: 7 } },
				diagnostic,
			),
		).toEqual({ handoffs: 7, diagnostic, invalid: false })
	})
	it.each([-1, 1.5, 1e99, '7', null])(
		'marks malformed proof invalid, not a fresh zero-budget retry: %s',
		(handoffs) => {
			expect(
				readOutboxQueueState(
					{ v: 1, replayProof: { v: 1, handoffs } },
					'synthetic original failure',
				),
			).toEqual({
				handoffs: 0,
				diagnostic: 'synthetic original failure',
				invalid: true,
				heldBatchBlocked: true,
			})
		},
	)
	it('retains the abandoned-publication claim separately from successful handoffs', () => {
		expect(
			readOutboxQueueState(
				{
					v: 1,
					replayProof: {
						v: 1,
						handoffs: 2,
						publicationId: 'synthetic-publication',
					},
				},
				'synthetic failure',
			),
		).toEqual({
			handoffs: 2,
			diagnostic: 'synthetic failure',
			publicationId: 'synthetic-publication',
			invalid: false,
		})
	})
	it.each(['', null, 17, 'x'.repeat(129)])(
		'rejects malformed publication claims: %s',
		(publicationId) => {
			expect(
				readOutboxQueueState(
					{ v: 1, replayProof: { v: 1, handoffs: 2, publicationId } },
					'synthetic failure',
				),
			).toMatchObject({
				handoffs: 0,
				diagnostic: 'synthetic failure',
				invalid: true,
			})
		},
	)
	it('does not rewrite, truncate or discard malformed retained evidence', () => {
		const value = {
			v: 1,
			replayProof: { v: 1, handoffs: 'bad' },
			continuation: { v: 1, encoded: { synthetic: 'invalid' } },
		}
		const before = JSON.stringify(value)
		expect(readOutboxQueueState(value, 'synthetic original')).toMatchObject({
			handoffs: 0,
			diagnostic: 'synthetic original',
			invalid: true,
		})
		expect(JSON.stringify(value)).toBe(before)
	})
})
