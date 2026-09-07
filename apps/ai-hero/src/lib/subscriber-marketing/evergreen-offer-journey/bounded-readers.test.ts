import { Effect, Either } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
	createBoundedJourneyReaders,
	restoreSourceCandidate,
} from './bounded-readers'
import {
	sourceFixture,
	currentCourseSourceFixture,
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
	it('reads the current DeliverySettled writer payload with floored SQL time', async () => {
		const row = currentCourseSourceFixture()
		const payload = row.payloadSummary.coursePayload.payload
		expect(payload.progression.trigger).toEqual({
			type: 'DeliverySettled',
			evaluatedAt: '2026-09-04T17:00:00.789Z',
			plannedAvailableAt: '2026-09-06T00:00:00.000Z',
			policy: 'EighteenHourFloorThenLocalNine',
		})
		expect(row.providerEventId).toBe(row.id)
		expect(row.providerReference).toBe(
			`email-course:email-course:skills-workflow:${payload.actor.courseEntryEventId}`,
		)
		expect(row.occurredAt.toISOString()).toBe('2026-09-04T17:00:00.000Z')
		const query = queryFixture([row])
		const readers = createBoundedJourneyReaders(
			query.database,
			makeInMemoryJourneyLedger(),
		)
		const page = await Effect.runPromise(
			readers.source({ now: new Date(payload.exhaustedAt), limit: 10 }),
		)
		expect(page.held).toEqual([])
		expect(page.candidates).toHaveLength(1)
		expect(page.candidates[0]).toMatchObject({
			entryFactId: row.id,
			contactId: row.contactId,
			exhaustedAt: payload.exhaustedAt,
		})
		expect(
			restoreSourceCandidate({
				...row,
				occurredAt: new Date('2026-09-04T17:00:01.000Z'),
			}),
		).toBeNull()
	})
	it.each(['wakes', 'intents'] as const)(
		'fails the whole %s page on non-decode ledger unavailability without leaking its cause',
		async (kind) => {
			const entry = fixtureEntry()
			const wake = entry.decision.wakeIntents[0]!
			const commit = fixtureWake(entry.decision.next)
			const intent = commit.decision.sideEffectIntents[0]
			if (!intent || intent.type !== 'SendMessage')
				throw new Error('Missing message')
			const row =
				kind === 'wakes'
					? {
							wakeId: wake.wakeId,
							journeyId: wake.journeyId,
							originatingStimulusId: entry.stimulus.stimulusId,
							dueAt: new Date(wake.dueAt),
						}
					: {
							idempotencyKey: intent.idempotencyKey,
							journeyId: intent.journeyId,
							originatingStimulusId: commit.stimulus.stimulusId,
							availableAt: new Date(intent.notBefore),
						}
			const query = queryFixture([row])
			const findCommittedStimulus = vi.fn(() =>
				Effect.fail({
					type: 'JourneyCommitUnavailable' as const,
					reason: 'synthetic-private-storage-detail',
				}),
			)
			const readers = createBoundedJourneyReaders(query.database, {
				findCommittedStimulus,
			})
			const input = { now: new Date(intent.notAfter), limit: 10 }
			const result =
				kind === 'wakes'
					? await Effect.runPromise(Effect.either(readers.wakes(input)))
					: await Effect.runPromise(Effect.either(readers.intents(input)))
			expect(findCommittedStimulus).toHaveBeenCalledOnce()
			expect(result).toEqual(
				Either.left({ type: 'ReaderFailure', reason: 'ReadUnavailable' }),
			)
			expect(JSON.stringify(result)).not.toContain(
				'synthetic-private-storage-detail',
			)
			expect(result).not.toHaveProperty('right')
		},
	)
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
