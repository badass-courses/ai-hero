import { describe, expect, it } from 'vitest'
import { drovrOutboxDedupeKey } from './drovr-outbox'
import {
	encodeHeldContinuationEnvelope,
	readHeldContinuationEnvelope,
	type OwnerStopRejection,
} from './drovr-outbox-control'
import {
	decideOwnerStopRejection,
	type OwnerStopRejectionRow,
} from './drovr-owner-stop-rejection'

const at = '2026-10-16T12:00:00.000Z'
const decidedAt = '2026-10-16T12:01:00.000Z'
function fixture(): OwnerStopRejectionRow {
	const scope = {
		target: 'https://drovr.example.test|production',
		endpoint: 'events' as const,
		tenantId: 'org-aihero' as const,
		contactId: 'synthetic-contact',
		journeyId: 'synthetic-owner-journey',
		eventType: 'purchase.recorded' as const,
		idempotencyKey: 'owner:synthetic:purchase:one',
		occurredAt: at,
	}
	const key = drovrOutboxDedupeKey(scope.target, scope)
	const receipt: OwnerStopRejection = {
		v: 1,
		scope: { key, ...scope },
		rejectionCode: 'cold-start-never-born',
		httpStatus: 409,
		rejectedAttempt: {
			runId: 'synthetic-sdk-run',
			requestId: '10000000-0000-4000-8000-000000000001',
			stepKey: key,
			attempt: 0,
		},
		decidedAt,
	}
	return {
		dedupeKey: key,
		...scope,
		status: 'rejected',
		lastStatus: 409,
		lastAttemptAt: decidedAt,
		lastError: 'operator prose only',
		body: {
			tenantId: scope.tenantId,
			contactId: scope.contactId,
			journeyId: scope.journeyId,
			idempotencyKey: scope.idempotencyKey,
			type: scope.eventType,
			occurredAt: at,
		},
		heldContinuation: { v: 1, ownerStopRejection: receipt },
	}
}
type Mutable<T> = {
	-readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K]
}
const receiptOf = (row: OwnerStopRejectionRow) =>
	(row.heldContinuation as { ownerStopRejection: Mutable<OwnerStopRejection> })
		.ownerStopRejection

// Every field of the receipt and its row binding participates in this table.
describe('typed owner-stop rejection gate exclusion', () => {
	it('excludes only a proved terminal owner rejection, never a positive receipt', () => {
		const row = fixture()
		expect(decideOwnerStopRejection(row)).toEqual({
			exclude: true,
			receipt: receiptOf(row),
		})
		row.body = JSON.stringify(row.body)
		row.heldContinuation = encodeHeldContinuationEnvelope(row.heldContinuation)
		expect(decideOwnerStopRejection(row).exclude).toBe(true)
	})
	it.each([
		'pending',
		'deferred',
		'held',
		'delivered',
		'superseded',
		'unknown',
	])('keeps status %s gated even with a valid receipt', (status) => {
		expect(decideOwnerStopRejection({ ...fixture(), status })).toMatchObject({
			exclude: false,
			issue: 'row-not-rejected',
		})
	})
	it.each([
		['absent', undefined],
		['SQL NULL', null],
		['JSON NULL', 'null'],
		['empty envelope', { v: 1 }],
		['wrong envelope version', { v: 2 }],
		['non JSON', '{'],
		['empty receipt', { v: 1, ownerStopRejection: {} }],
	])(
		'keeps %s proof gated with an actionable reason',
		(_label, heldContinuation) => {
			const result = decideOwnerStopRejection({
				...fixture(),
				heldContinuation,
			})
			expect(result.exclude).toBe(false)
			if (!result.exclude) {
				expect(result.message).toContain(result.issue)
				expect(result.message).toMatch(/Accepted:.*Fix:.*Debug:/)
			}
		},
	)
	it.each([
		'key',
		'target',
		'endpoint',
		'tenantId',
		'contactId',
		'journeyId',
		'eventType',
		'idempotencyKey',
		'occurredAt',
	] as const)('keeps missing scope.%s gated', (field) => {
		const row = fixture()
		delete (receiptOf(row).scope as Record<string, unknown>)[field]
		expect(decideOwnerStopRejection(row)).toMatchObject({
			exclude: false,
			issue: 'malformed-receipt',
		})
	})
	it.each([
		'dedupeKey',
		'target',
		'endpoint',
		'tenantId',
		'contactId',
		'journeyId',
		'eventType',
		'idempotencyKey',
		'occurredAt',
	] as const)('keeps a different row %s gated', (field) => {
		const row = fixture()
		row[field] = field === 'occurredAt' ? decidedAt : `different-${row[field]}`
		expect(decideOwnerStopRejection(row)).toMatchObject({
			exclude: false,
			issue: 'scope-mismatch',
		})
	})
	it.each([
		'tenantId',
		'contactId',
		'journeyId',
		'idempotencyKey',
		'type',
		'occurredAt',
	])('keeps a different immutable body %s gated', (field) => {
		const row = fixture()
		;(row.body as Record<string, unknown>)[field] = 'different'
		expect(decideOwnerStopRejection(row)).toMatchObject({
			exclude: false,
			issue: 'body-mismatch',
		})
	})
	it.each([null, '{', [], 'null', 42])(
		'keeps malformed retained body %j gated',
		(body) => {
			expect(decideOwnerStopRejection({ ...fixture(), body })).toMatchObject({
				exclude: false,
				issue: 'body-mismatch',
			})
		},
	)
	it.each([
		'v',
		'rejectionCode',
		'httpStatus',
		'rejectedAttempt',
		'decidedAt',
	] as const)('keeps missing receipt %s gated', (field) => {
		const row = fixture()
		delete (receiptOf(row) as unknown as Record<string, unknown>)[field]
		expect(decideOwnerStopRejection(row)).toMatchObject({
			exclude: false,
			issue: 'malformed-receipt',
		})
	})
	it.each(['runId', 'requestId', 'stepKey', 'attempt'] as const)(
		'keeps missing rejectedAttempt.%s gated',
		(field) => {
			const row = fixture()
			delete (receiptOf(row).rejectedAttempt as Record<string, unknown>)[field]
			expect(decideOwnerStopRejection(row)).toMatchObject({
				exclude: false,
				issue: 'malformed-receipt',
			})
		},
	)
	it.each([
		[
			'directory row',
			(row: OwnerStopRejectionRow) => {
				row.journeyId = 'contact-directory'
			},
			'directory-scope',
		],
		[
			'directory receipt',
			(row: OwnerStopRejectionRow) => {
				receiptOf(row).scope.journeyId = 'contact-directory'
			},
			'malformed-receipt',
		],
		[
			'unprefixed key',
			(row: OwnerStopRejectionRow) => {
				receiptOf(row).scope.idempotencyKey = 'purchase:one'
			},
			'malformed-receipt',
		],
		[
			'unknown code',
			(row: OwnerStopRejectionRow) => {
				;(receiptOf(row) as any).rejectionCode = 'event-not-live'
			},
			'malformed-receipt',
		],
		[
			'unrelated attempt',
			(row: OwnerStopRejectionRow) => {
				receiptOf(row).rejectedAttempt.stepKey = 'f'.repeat(64)
			},
			'malformed-receipt',
		],
		[
			'negative attempt',
			(row: OwnerStopRejectionRow) => {
				receiptOf(row).rejectedAttempt.attempt = -1
			},
			'malformed-receipt',
		],
		[
			'invalid request id',
			(row: OwnerStopRejectionRow) => {
				receiptOf(row).rejectedAttempt.requestId = 'not-an-attempt'
			},
			'malformed-receipt',
		],
		[
			'noncanonical decision',
			(row: OwnerStopRejectionRow) => {
				receiptOf(row).decidedAt = '2026-10-16T12:01:00Z'
			},
			'malformed-receipt',
		],
		[
			'success status',
			(row: OwnerStopRejectionRow) => {
				receiptOf(row).httpStatus = 202
			},
			'malformed-receipt',
		],
		[
			'different HTTP history',
			(row: OwnerStopRejectionRow) => {
				row.lastStatus = 403
			},
			'attempt-mismatch',
		],
		[
			'missing HTTP history',
			(row: OwnerStopRejectionRow) => {
				row.lastStatus = null
			},
			'attempt-mismatch',
		],
		[
			'newer HTTP attempt',
			(row: OwnerStopRejectionRow) => {
				row.lastAttemptAt = '2026-10-16T12:02:00.000Z'
			},
			'attempt-mismatch',
		],
		[
			'missing HTTP attempt',
			(row: OwnerStopRejectionRow) => {
				row.lastAttemptAt = null
			},
			'attempt-mismatch',
		],
	] as const)('keeps %s gated', (_label, change, issue) => {
		const row = fixture()
		change(row)
		expect(decideOwnerStopRejection(row)).toMatchObject({
			exclude: false,
			issue,
		})
	})
	it('preserves all independent members under the same strict envelope bound', () => {
		const row = fixture()
		const state = {
			...(row.heldContinuation as object),
			continuation: {
				v: 1,
				blocked: true,
				reason: 'synthetic held coordinator',
			},
			replayProof: { v: 1, handoffs: 3 },
		}
		expect(
			readHeldContinuationEnvelope(encodeHeldContinuationEnvelope(state)),
		).toEqual(state)
		expect(() =>
			encodeHeldContinuationEnvelope({
				...state,
				ownerStopRejection: { ...receiptOf(row), body: 'forbidden' },
			}),
		).toThrow('OutboxControl:')
	})
	it('property: no lookalike lastError changes a verdict (seeded 250 cases)', () => {
		let seed = 0x41a7
		for (let trial = 0; trial < 250; trial++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			const error = [
				null,
				'cold-start-never-born: released',
				'OwnerStopRejection: valid',
				JSON.stringify(fixture().heldContinuation),
				`event-not-live: ${seed}`,
				`cold-start-never-born: ${'🧪'.repeat(seed % 50)}`,
			][trial % 6]!
			for (const proof of [
				'valid',
				'missing',
				'malformed',
				'foreign',
			] as const) {
				const row = fixture()
				if (proof === 'missing') row.heldContinuation = undefined
				if (proof === 'malformed')
					row.heldContinuation = { v: 1, ownerStopRejection: { v: 1 } }
				if (proof === 'foreign')
					receiptOf(row).scope.contactId = 'another-contact'
				expect(
					decideOwnerStopRejection({ ...row, lastError: error }).exclude,
				).toBe(proof === 'valid')
			}
		}
	})
	it('never even reads error prose, including a throwing getter', () => {
		const row = fixture()
		Object.defineProperty(row, 'lastError', {
			get: () => {
				throw new Error('error prose became a protocol')
			},
		})
		expect(decideOwnerStopRejection(row).exclude).toBe(true)
		row.heldContinuation = undefined
		expect(decideOwnerStopRejection(row)).toMatchObject({
			exclude: false,
			issue: 'missing-receipt',
		})
	})
})
