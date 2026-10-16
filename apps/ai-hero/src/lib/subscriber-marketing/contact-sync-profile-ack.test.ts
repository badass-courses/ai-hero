import { expect, it } from 'vitest'
import { buildContactProfileEvents } from './drovr-contact-profile-sync'
import {
	drovrOutboxDedupeKey,
	outboxEntryForEvent,
	type DrovrOutboxRow,
} from './drovr-outbox'
import type {
	DrovrContactProfilePayload,
	DrovrShadowEvent,
} from './drovr-shadow-emitter'
import {
	evaluateProfileAckCompletion,
	freezeProfileAckRequest,
	profileAckConfirmationClock,
	ProfileAckConflict,
} from './contact-sync-profile-ack'

const at = '2032-01-01T00:00:00.000Z'
const target = 'synthetic-frozen-ack-target'
function fixture(period?: string) {
	const clock = period ? `${period}-01T00:00:00.000Z` : at
	const events = buildContactProfileEvents({
		contactId: 'synthetic-contact',
		profileVersion: 3,
		occurredAt: clock,
		profile: { email: 'synthetic@example.test', firstName: null, holds: [] },
		links: period
			? []
			: [
					{
						journeyId: 'value-path-skills-course',
						emailKey: 'synthetic-message',
						issuedAt: at,
						expiresAt: '2032-05-01T00:00:00.000Z',
						variables: {},
						sendTimeFields: [],
					},
				],
		offers: [],
	})
	if (period) events[0]!.idempotencyKey += `:restate:${period}`
	const rows: DrovrOutboxRow[] = events.map((event) => {
		const entry = outboxEntryForEvent(
			event,
			period ? 'bulkRestate' : 'bulkDelta',
		)
		const key = drovrOutboxDedupeKey(target, entry)
		return {
			...entry,
			id: key,
			target,
			dedupeKey: key,
			status: 'delivered',
			attempts: 0,
			lastStatus: 202,
			lastError: null,
			firstFailedAt: clock,
			nextAttemptAt: clock,
			lastAttemptAt: '2032-03-20T00:00:00.000Z',
			deliveredAt: '2032-03-20T00:00:00.000Z',
			releasedAt: null,
			createdAt: clock,
		}
	})
	const freeze = () =>
		freezeProfileAckRequest({
			target,
			contactId: 'synthetic-contact',
			profileVersion: 3,
			registeredAt: clock,
			rows,
		})
	return { rows, freeze }
}
it('freezes exact first-body scoped references and never includes a later derived offer read', () => {
	const f = fixture(),
		state = f.freeze()
	expect(state.members).toHaveLength(2)
	expect(state.members.map((member) => member.eventType).sort()).toEqual([
		'contact.links.issued',
		'contact.profile.updated',
	])
	expect(state.ref.request).toEqual({ kind: 'delta' })
	expect(JSON.stringify(state)).not.toContain('synthetic@example.test')
	expect(JSON.stringify(state)).not.toContain('"body":')
})
it('waits for every requested member rather than promoting durable handoff or a held row', () => {
	const f = fixture(),
		state = f.freeze()
	for (const status of ['pending', 'deferred', 'held', 'superseded'] as const) {
		f.rows[1]!.status = status
		expect(evaluateProfileAckCompletion(state, f.rows)._tag).toBe(
			'ProfileAckWaiting',
		)
	}
	f.rows[1]!.status = 'rejected'
	expect(evaluateProfileAckCompletion(state, f.rows)._tag).toBe(
		'ProfileAckReceiverRefused',
	)
	f.rows[1]!.status = 'delivered'
	f.rows[1]!.heldBatchBlocked = true
	expect(evaluateProfileAckCompletion(state, f.rows)).toMatchObject({
		_tag: 'ProfileAckWaiting',
		reason: 'blocked',
	})
})
it('does not confuse delivered status without a receipt timestamp with a complete proof', () => {
	const f = fixture(),
		state = f.freeze()
	f.rows[1]!.deliveredAt = null
	expect(evaluateProfileAckCompletion(state, f.rows)).toEqual({
		_tag: 'ProfileAckWaiting',
		reason: 'missing-receipt',
	})
})
it('Jan 1 delivered on March 20 still ages from Jan 1, never provedAt or delayed worker time', () => {
	const f = fixture(),
		result = evaluateProfileAckCompletion(f.freeze(), f.rows)
	if (result._tag !== 'ProfileAckReady')
		throw new Error('fixture has no receiver proof')
	expect(result.proof.confirmationClock).toBe(at)
	expect(result.proof.provedAt).toBe('2032-03-20T00:00:00.000Z')
	expect(profileAckConfirmationClock(result.proof, undefined)).toBe(at)
	const ageAtMarch20 =
		Date.parse('2032-03-20T00:00:00.000Z') -
		Date.parse(profileAckConfirmationClock(result.proof, null))
	expect(ageAtMarch20).toBeGreaterThan(30 * 86400000)
})
it('fixes one delivered proof and treats identical retained proof replay as a no-op', () => {
	const f = fixture(),
		state = f.freeze(),
		result = evaluateProfileAckCompletion(state, f.rows)
	if (result._tag !== 'ProfileAckReady')
		throw new Error('fixture has no receiver proof')
	const completed = {
		...state,
		completion: { ...result.proof, disposition: 'acknowledged' as const },
	}
	expect(evaluateProfileAckCompletion(completed, f.rows)).toEqual({
		...result,
		alreadyCompleted: true,
	})
	f.rows[1]!.deliveredAt = '2032-03-21T00:00:00.000Z'
	expect(() => evaluateProfileAckCompletion(completed, f.rows)).toThrow(
		/different delivered proof/,
	)
})
it.each(['body', 'first-clock', 'source'] as const)(
	'refuses different %s evidence for the same frozen request',
	(change) => {
		const f = fixture(),
			state = f.freeze()
		if (change === 'body') {
			const body = f.rows[0]!.body as DrovrShadowEvent
			f.rows[0]!.body = {
				...body,
				payload: {
					...(body.payload as DrovrContactProfilePayload),
					firstName: 'changed synthetic value',
				},
			}
		} else if (change === 'first-clock')
			f.rows[0]!.firstFailedAt = '2032-01-02T00:00:00.000Z'
		else for (const row of f.rows) row.source = 'bulkRestate'
		expect(() => evaluateProfileAckCompletion(state, f.rows)).toThrow(
			ProfileAckConflict,
		)
	},
)
it('canonicalizes actual JSON key order without rebasing a first clock or reading diagnostic fields', () => {
	const f = fixture(),
		state = f.freeze(),
		first = evaluateProfileAckCompletion(state, f.rows)
	for (const row of f.rows) {
		row.body = Object.fromEntries(
			Object.entries(row.body).reverse(),
		) as DrovrShadowEvent
		row.attempts = 999
		row.lastStatus = 503
		Object.defineProperty(row, 'lastError', {
			get: () => {
				throw new Error('operator prose read as ACK authority')
			},
		})
	}
	expect(evaluateProfileAckCompletion(state, f.rows)).toEqual(first)
})
it('returns terminal AckEvidenceExpired on purged membership without mutating evidence or throwing', () => {
	const f = fixture(),
		state = f.freeze(),
		saved = JSON.stringify(state)
	for (const rows of [[], f.rows.slice(1)]) {
		const result = evaluateProfileAckCompletion(state, rows)
		expect(result._tag).toBe('AckEvidenceExpired')
		expect(result).not.toBeInstanceOf(Error)
		expect(JSON.stringify(state)).toBe(saved)
	}
})
it('rejects duplicated or foreign scoped rows rather than calling them expired evidence', () => {
	const f = fixture(),
		state = f.freeze()
	expect(() =>
		evaluateProfileAckCompletion(state, [f.rows[0]!, f.rows[0]!]),
	).toThrow(ProfileAckConflict)
	f.rows[0]!.target = 'another-target'
	expect(() => evaluateProfileAckCompletion(state, f.rows)).toThrow(
		ProfileAckConflict,
	)
})
it('two monthly periods are distinct frozen requests at the same version, with same-period replay unchanged', () => {
	let age: string | undefined
	const ids: string[] = []
	for (const period of ['2032-01', '2032-02']) {
		const f = fixture(period),
			state = f.freeze(),
			result = evaluateProfileAckCompletion(state, f.rows)
		if (result._tag !== 'ProfileAckReady')
			throw new Error('fixture has no receiver proof')
		ids.push(state.ref.requestId)
		age = profileAckConfirmationClock(result.proof, age)
		expect(age).toBe(`${period}-01T00:00:00.000Z`)
		const completed = {
			...state,
			completion: { ...result.proof, disposition: 'acknowledged' as const },
		}
		expect(evaluateProfileAckCompletion(completed, f.rows)).toMatchObject({
			_tag: 'ProfileAckReady',
			alreadyCompleted: true,
		})
		expect(age).toBe(`${period}-01T00:00:00.000Z`)
	}
	expect(new Set(ids).size).toBe(2)
})
it('refuses a backward confirmation clock with a literal non-retriable conflict', () => {
	const f = fixture(),
		result = evaluateProfileAckCompletion(f.freeze(), f.rows)
	if (result._tag !== 'ProfileAckReady')
		throw new Error('fixture has no receiver proof')
	expect(() =>
		profileAckConfirmationClock(result.proof, '2032-02-01T00:00:00.000Z'),
	).toThrow('CONFIRMATION CLOCK WOULD MOVE BACKWARD')
	expect(profileAckConfirmationClock(result.proof, at)).toBe(at)
})
