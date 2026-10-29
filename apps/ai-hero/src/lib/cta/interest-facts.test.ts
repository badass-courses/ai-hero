import { describe, expect, it, vi } from 'vitest'

import { recordInterestFact } from './interest-fact-recorder'
import {
	drovrInterestFact,
	interestFieldKeysOf,
	interestFieldsFromFacts,
	interestKitWritesEnabled,
} from './interest-facts'
import { requestInterestFacts } from './interest-facts.server'

vi.mock('@/server/logger', () => ({
	log: { error: vi.fn().mockResolvedValue(undefined) },
}))

const data = {
	email: 'reader@example.test',
	fieldKey: 'waitlist_ai_coding_crash_course',
	expressedAt: '2026-10-29T12:00:00.000Z',
	via: 'one-click' as const,
}

describe('interest fact shapes', () => {
	it('takes only set waitlist and interest keys from a form', () => {
		expect(
			interestFieldKeysOf({
				waitlist_c6: '2026-10-29',
				interest_claude_code: '2026-10-29',
				interest_empty: ' ',
				source: 'aihero_cohort_page',
				'waitlist_Bad Key': 'x',
				aih_course_started_at: '2026-10-29',
			}),
		).toEqual(['waitlist_c6', 'interest_claude_code'])
		expect(interestFieldKeysOf(undefined)).toEqual([])
		expect(interestFieldKeysOf(['waitlist_c6'])).toEqual([])
	})

	it('reads local rows back as the date fields gating already checks, first join wins', () => {
		expect(
			interestFieldsFromFacts([
				{
					providerReference: 'interest:waitlist_c6',
					occurredAt: new Date('2026-10-29T23:00:00Z'),
				},
				{
					providerReference: 'interest:waitlist_c6',
					occurredAt: '2026-10-20T01:00:00Z',
				},
				{ providerReference: 'kit:something', occurredAt: new Date() },
				{ providerReference: 'interest:waitlist_c7', occurredAt: 'nope' },
			]),
		).toEqual({ waitlist_c6: '2026-10-20' })
	})

	it('builds a drovr fact with a stable, email-free source id', () => {
		const fact = drovrInterestFact({
			drovrContactId: 'drovr-1',
			fieldKey: 'waitlist_c6',
			at: '2026-10-29T12:00:00Z',
		})
		expect(fact).toEqual({
			contactId: 'drovr-1',
			at: '2026-10-29T12:00:00.000Z',
			kind: 'aihero.waitlist',
			role: 'waitlist_c6',
			sourceId: '["aihero","interest.expressed","waitlist_c6","drovr-1"]',
		})
		expect(
			drovrInterestFact({
				drovrContactId: 'drovr-1',
				fieldKey: 'interest_claude_code',
				at: '2026-10-29T12:00:00Z',
			}).kind,
		).toBe('aihero.interest')
	})

	it('keeps Kit written unless the cut is spelled exactly', () => {
		expect(interestKitWritesEnabled({})).toBe(true)
		expect(interestKitWritesEnabled({ AIH_INTEREST_KIT_WRITES: 'false' })).toBe(
			true,
		)
		expect(interestKitWritesEnabled({ AIH_INTEREST_KIT_WRITES: 'off' })).toBe(
			false,
		)
	})
})

describe('requestInterestFacts', () => {
	it('queues nothing while the switch is off', async () => {
		const sender = { send: vi.fn() }
		vi.stubEnv('AIH_INTEREST_FACTS_ENABLED', '')
		expect(
			await requestInterestFacts({
				email: data.email,
				fields: { waitlist_c6: 'x' },
				via: 'form',
				sender,
			}),
		).toEqual({ queued: 0 })
		expect(sender.send).not.toHaveBeenCalled()
		vi.unstubAllEnvs()
	})

	it('answers zero, never throws, when the queue is down', async () => {
		vi.stubEnv('AIH_INTEREST_FACTS_ENABLED', 'true')
		const sender = { send: vi.fn().mockRejectedValue(new Error('down')) }
		expect(
			await requestInterestFacts({
				email: data.email,
				fields: { waitlist_c6: 'x' },
				via: 'form',
				sender,
			}),
		).toEqual({ queued: 0 })
		vi.unstubAllEnvs()
	})
})

describe('recordInterestFact', () => {
	const deps = (
		over: Partial<Parameters<typeof recordInterestFact>[0]> = {},
	) => ({
		findContactIdForEmail: vi.fn().mockResolvedValue('local-1'),
		writeLocalInterestFact: vi.fn().mockResolvedValue({
			status: 'inserted',
			occurredAt: data.expressedAt,
		}),
		drovr: {
			resolve: vi
				.fn()
				.mockResolvedValue({ status: 'resolved', contactId: 'drovr-1' }),
			record: vi.fn().mockResolvedValue(undefined),
		},
		...over,
	})

	it('join: one local row and one drovr fact', async () => {
		const d = deps()
		expect(await recordInterestFact(d, data)).toEqual({
			local: 'inserted',
			drovr: 'recorded',
		})
		expect(d.writeLocalInterestFact).toHaveBeenCalledWith({
			contactId: 'local-1',
			fieldKey: 'waitlist_ai_coding_crash_course',
			at: data.expressedAt,
		})
		expect(d.drovr.record).toHaveBeenCalledWith(
			expect.objectContaining({ contactId: 'drovr-1', at: data.expressedAt }),
		)
	})

	it('already joined: drovr gets the first join time, not this click', async () => {
		const d = deps({
			writeLocalInterestFact: vi.fn().mockResolvedValue({
				status: 'existing',
				occurredAt: '2026-10-01T00:00:00.000Z',
			}),
		})
		expect(
			await recordInterestFact(d, {
				...data,
				expressedAt: '2026-10-29T15:00:00.000Z',
			}),
		).toEqual({ local: 'existing', drovr: 'recorded' })
		expect(d.drovr.record).toHaveBeenCalledWith(
			expect.objectContaining({ at: '2026-10-01T00:00:00.000Z' }),
		)
	})

	it('a new address the site and drovr do not know yet: nothing written, an answer to wait on', async () => {
		const d = deps({
			findContactIdForEmail: vi.fn().mockResolvedValue(undefined),
			drovr: {
				resolve: vi.fn().mockResolvedValue({ status: 'missing' }),
				record: vi.fn(),
			},
		})
		expect(await recordInterestFact(d, data)).toEqual({
			local: 'no-contact',
			drovr: 'unresolved',
		})
		expect(d.writeLocalInterestFact).not.toHaveBeenCalled()
		expect(d.drovr.record).not.toHaveBeenCalled()
	})

	it('refuses a key that is not a waitlist or interest field', async () => {
		const d = deps()
		expect(
			await recordInterestFact(d, {
				...data,
				fieldKey: 'aih_course_started_at',
			}),
		).toEqual({ local: 'invalid', drovr: 'skipped' })
		expect(d.findContactIdForEmail).not.toHaveBeenCalled()
	})

	it('a drovr transport failure throws so the job retries', async () => {
		const record = vi
			.fn()
			.mockRejectedValue(new Error('interest-fact-http-failed'))
		const d = deps({
			drovr: {
				resolve: vi
					.fn()
					.mockResolvedValue({ status: 'resolved', contactId: 'drovr-1' }),
				record,
			},
		})
		await expect(recordInterestFact(d, data)).rejects.toThrow(
			'interest-fact-http-failed',
		)
	})
})
