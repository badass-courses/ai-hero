import { Effect, Either } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
	createBoundedJourneyReaders,
	restoreSourceCandidate,
} from './bounded-readers'
import {
	sourceFixture,
	fixtureEntry,
	fixtureWake,
} from './bounded-readers.fixtures'
import { makeInMemoryJourneyLedger } from './in-memory-ledger'
import { SKILLS_WORKFLOW_PATH_SLUGS } from '../skills-workflow-path'
import {
	readCoursePayload,
	COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
} from '../course-sequence-exhaustion'

function queryFixture(rows: unknown[]) {
	const limit = vi.fn(async () => rows)
	const select = vi.fn(() => ({
		from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
	}))
	return {
		database: { select } as unknown as Parameters<
			typeof createBoundedJourneyReaders
		>[0],
		limit,
		select,
	}
}
describe('bounded reader boundaries', () => {
	it.each(SKILLS_WORKFLOW_PATH_SLUGS)(
		'restores actual approved path %s without minting a fact',
		(path) => {
			const row = sourceFixture('fact-a', path)
			const candidate = restoreSourceCandidate(row)
			expect(candidate).toMatchObject({
				entryFactId: row.id,
				stimulusId: row.id,
				valuePathId: path,
			})
			expect(restoreSourceCandidate(row)).toEqual(candidate)
		},
	)
	it('also accepts the current Email Course atomic producer reference', () => {
		const row = sourceFixture()
		expect(
			restoreSourceCandidate({
				...row,
				providerEventId: row.id,
				providerReference:
					'email-course:email-course:skills-workflow:entry-fact-a',
			})?.entryFactId,
		).toBe(row.id)
	})
	it('holds wrong versions, identity, semantic keys, path, zone and time', () => {
		const row = sourceFixture()
		const stored = readCoursePayload(row.payloadSummary)
		const payload = stored?.payload as Record<string, unknown>
		const invalidZone = {
			...payload,
			deadlineTimeZone: {
				type: 'BrowserEntryHeader',
				headerName: 'x-vercel-ip-timezone',
				timeZone: 'not-a-zone',
				capturedAt: '2026-08-30T02:00:00.000Z',
			},
		}
		for (const bad of [
			{ ...row, schemaVersion: 2 },
			{ ...row, id: ' fact-a ' },
			{ ...row, contactId: 'other' },
			{ ...row, semanticIdempotencyKey: 'other' },
			{ ...row, provider: 'kit' },
			{ ...row, providerReference: 'value-path:wrong-path' },
			{ ...row, providerEventId: 'wrong-provider-event' },
			{ ...row, occurredAt: new Date('2026-01-01') },
			sourceFixture('other', 'unapproved-path'),
			{
				...row,
				payloadSummary: {
					summary: 'Synthetic',
					keywords: [],
					restrictedPayloadStored: false,
					coursePayload: {
						format: COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
						payload: invalidZone,
					},
				},
			},
		])
			expect(restoreSourceCandidate(bad)).toBeNull()
	})
	it('advances scanned cursor on a full held-only source page and exposes bounded reasons', async () => {
		const row = { ...sourceFixture(), schemaVersion: 9 }
		const query = queryFixture([row])
		const reader = createBoundedJourneyReaders(
			query.database,
			makeInMemoryJourneyLedger(),
		)
		const result = await Effect.runPromise(
			reader.source({ now: row.occurredAt, limit: 1 }),
		)
		expect(result).toMatchObject({
			candidates: [],
			scanned: 1,
			end: false,
			nextCursor: { id: row.id, at: row.occurredAt.toISOString() },
			held: [{ reason: 'InvalidSource' }],
		})
		expect(query.limit).toHaveBeenCalledWith(1)
	})
	it('rejects invalid page sizes/cursors before SQL and distinguishes an empty range', async () => {
		const query = queryFixture([])
		const reader = createBoundedJourneyReaders(
			query.database,
			makeInMemoryJourneyLedger(),
		)
		for (const limit of [0, 101, 1.5]) {
			const result = await Effect.runPromise(
				Effect.either(reader.source({ now: new Date(), limit })),
			)
			expect(Either.isLeft(result) && result.left.reason).toBe('InvalidPage')
		}
		for (const after of [
			{ at: 'invalid', id: 'x' },
			{ at: '2026-09-04T17:00:00.000Z', id: '' },
		]) {
			const result = await Effect.runPromise(
				Effect.either(reader.source({ now: new Date(), limit: 1, after })),
			)
			expect(Either.isLeft(result) && result.left.reason).toBe('InvalidPage')
		}
		expect(query.select).not.toHaveBeenCalled()
		expect(
			await Effect.runPromise(reader.source({ now: new Date(), limit: 1 })),
		).toMatchObject({ end: true, scanned: 0, nextCursor: null })
	})
	it('restores due evidence through the existing ledger and classifies expiry without sending', async () => {
		const ledger = makeInMemoryJourneyLedger()
		const entry = fixtureEntry()
		await Effect.runPromise(ledger.commit(entry))
		const commit = fixtureWake(entry.decision.next)
		await Effect.runPromise(ledger.commit(commit))
		const intent = commit.decision.sideEffectIntents[0]
		if (!intent || intent.type !== 'SendMessage')
			throw new Error('Missing fixture message')
		const query = queryFixture([
			{
				idempotencyKey: intent.idempotencyKey,
				journeyId: intent.journeyId,
				originatingStimulusId: commit.stimulus.stimulusId,
				availableAt: new Date(intent.notBefore),
			},
		])
		const readers = createBoundedJourneyReaders(query.database, ledger)
		const before = ledger.records()
		expect(
			(
				await Effect.runPromise(
					readers.intents({ now: new Date(intent.notAfter), limit: 1 }),
				)
			).candidates,
		).toEqual([{ intent, window: 'Expired' }])
		expect(ledger.records()).toEqual(before)
	})
})
