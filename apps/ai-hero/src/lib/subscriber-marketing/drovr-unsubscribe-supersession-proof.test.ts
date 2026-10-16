import { describe, expect, it } from 'vitest'
import { drovrOutboxDedupeKey, outboxEntryForEvent } from './drovr-outbox'
import {
	buildUnsubscribeSupersession,
	readUnsubscribeSupersession,
	supersededUnsubscribeAt,
	type UnsubscribeProofRow,
} from './drovr-unsubscribe-supersession-proof'
import { readHeldContinuationEnvelope } from './drovr-outbox-control'

const stopAt = '2026-10-16T12:00:01.900Z'
const liftAt = '2026-10-16T12:00:02.000Z'
function fixture(): UnsubscribeProofRow {
	const target = 'synthetic-target'
	const event = {
		tenantId: 'org-aihero',
		contactId: 'synthetic-contact',
		journeyId: 'crash-course-evergreen-offer',
		type: 'contact.unsubscribed',
		idempotencyKey: 'synthetic:unsubscribe',
		occurredAt: stopAt,
	} as const
	const entry = outboxEntryForEvent(event, 'bulkIngest')
	const row: UnsubscribeProofRow = {
		...entry,
		target,
		dedupeKey: drovrOutboxDedupeKey(target, entry),
	}
	return {
		...row,
		heldContinuation: {
			v: 1,
			unsubscribeSupersession: buildUnsubscribeSupersession(
				row,
				liftAt,
				'2026-10-16T12:01:00.000Z',
			),
		},
	}
}
const proofOf = (row: UnsubscribeProofRow): any =>
	(row.heldContinuation as any).unsubscribeSupersession

describe('typed unsubscribe supersession proof', () => {
	it('retains a source-cited strictly newer whole-second lift without a POST or body/clock mutation', () => {
		const row = fixture()
		const before = structuredClone(row)
		expect(readUnsubscribeSupersession(row)).toMatchObject({
			proved: true,
			proof: {
				v: 1,
				source: {
					table: 'AI_ContactEvent',
					eventType: 'contact.resubscribed',
					contactId: row.contactId,
					occurredAt: liftAt,
				},
			},
		})
		expect(supersededUnsubscribeAt(row)).toBe(liftAt)
		expect(row).toEqual(before)
	})
	it('accepts MySQL JSON strings and UTC timestamps without changing the wire body', () => {
		const row = fixture()
		row.body = JSON.stringify(row.body)
		row.heldContinuation = JSON.stringify(row.heldContinuation)
		row.occurredAt = stopAt.replace('T', ' ').replace('Z', '')
		expect(supersededUnsubscribeAt(row)).toBe(liftAt)
	})
	it.each([
		'2026-10-16T12:00:00.000Z',
		stopAt,
		'2026-10-16T12:00:01.999Z',
		'invalid',
	])('never closes from tied/older/invalid lift %s', (at) => {
		const row = fixture()
		expect(() =>
			buildUnsubscribeSupersession(row, at, '2026-10-16T12:01:00.000Z'),
		).toThrow('OutboxControl:')
	})
	it.each(['contact.bounced', 'contact.complained'])(
		'never lifts %s',
		(eventType) => {
			const row = fixture()
			row.eventType = eventType
			;(row.body as any).type = eventType
			expect(readUnsubscribeSupersession(row)).toMatchObject({ proved: false })
			expect(() =>
				buildUnsubscribeSupersession(row, liftAt, '2026-10-16T12:01:00.000Z'),
			).toThrow('OutboxControl:')
		},
	)
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
	] as const)('rejects different immutable %s', (key) => {
		const row = fixture()
		row[key] = 'different'
		expect(readUnsubscribeSupersession(row)).toMatchObject({
			proved: false,
			issue: 'scope-mismatch',
		})
	})
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
	])('rejects incomplete scope.%s', (key) => {
		const row = fixture()
		delete proofOf(row).scope[key]
		expect(readUnsubscribeSupersession(row)).toMatchObject({
			proved: false,
			issue: 'malformed-proof',
		})
	})
	it.each([
		'tenantId',
		'contactId',
		'journeyId',
		'type',
		'idempotencyKey',
		'occurredAt',
	])('rejects a different first body %s', (key) => {
		const row = fixture()
		;(row.body as any)[key] = 'different'
		expect(readUnsubscribeSupersession(row)).toMatchObject({
			proved: false,
			issue: 'body-mismatch',
		})
	})
	it.each(['table', 'eventType', 'contactId', 'occurredAt'])(
		'rejects missing source.%s',
		(key) => {
			const row = fixture()
			delete proofOf(row).source[key]
			expect(readUnsubscribeSupersession(row)).toMatchObject({
				proved: false,
				issue: 'malformed-proof',
			})
		},
	)
	it.each(['table', 'eventType', 'contactId'])(
		'rejects foreign source.%s',
		(key) => {
			const row = fixture()
			proofOf(row).source[key] = 'different'
			expect(readUnsubscribeSupersession(row)).toMatchObject({
				proved: false,
				issue: 'malformed-proof',
			})
		},
	)
	it.each([
		undefined,
		null,
		'{',
		{ v: 1 },
		{ v: 1, unsubscribeSupersession: { v: 1 } },
		{ v: 2 },
	])(
		'keeps missing/malformed proof %j closed to authorization',
		(heldContinuation) => {
			expect(
				supersededUnsubscribeAt({ ...fixture(), heldContinuation }),
			).toBeUndefined()
		},
	)
	it('the fourth member coexists with continuation/replayProof under the same strict Schema', () => {
		const row = fixture()
		const state = {
			...(row.heldContinuation as object),
			continuation: { v: 1, blocked: true, reason: 'synthetic hold' },
			replayProof: { v: 1, handoffs: 1 },
		}
		expect(readHeldContinuationEnvelope(state)).toEqual(state)
		expect(() =>
			readHeldContinuationEnvelope({
				...state,
				unsubscribeSupersession: { ...proofOf(row), body: 'forbidden' },
			}),
		).toThrow('OutboxControl:')
	})
	it('property: no lookalike lastError authorizes supersession (250 seeded cases)', () => {
		let seed = 0x6031
		for (let trial = 0; trial < 250; trial++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			const lastError = [
				`superseded-unsubscribe:${liftAt}; newer contact.resubscribed`,
				JSON.stringify(fixture().heldContinuation),
				`UnsubscribeSuperseded: ${seed}`,
				null,
				`superseded-unsubscribe:${liftAt}; ${'🧪'.repeat(seed % 40)}`,
			][trial % 5]!
			const row = fixture()
			expect(supersededUnsubscribeAt({ ...row, lastError })).toBe(liftAt)
			expect(
				supersededUnsubscribeAt({
					...row,
					heldContinuation: undefined,
					lastError,
				}),
			).toBeUndefined()
			proofOf(row).scope.contactId = 'foreign-contact'
			expect(supersededUnsubscribeAt({ ...row, lastError })).toBeUndefined()
		}
	})
	it('never reads error prose, even a throwing getter', () => {
		const row = fixture()
		Object.defineProperty(row, 'lastError', {
			get: () => {
				throw new Error('prose became a closure protocol')
			},
		})
		expect(supersededUnsubscribeAt(row)).toBe(liftAt)
		row.heldContinuation = undefined
		expect(supersededUnsubscribeAt(row)).toBeUndefined()
	})
})
