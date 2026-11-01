import { describe, expect, it, vi } from 'vitest'

import { applyEmailPreferenceChange } from './email-preference-change'
import {
	readLocalEmailPreferences,
	type PreferenceLinkVerification,
} from './email-preferences-local'

const verified: PreferenceLinkVerification = {
	status: 'verified',
	subscriber: {
		id: '1234567',
		email_address: 'reader@example.test',
		contactId: 'contact-1',
	},
}

const change = {
	kitSubscriberId: '1234567',
	shKit: 'a'.repeat(64),
	preferenceKey: 'newsletter',
	subscribed: false,
	source: 'unsubscribe-link' as const,
	requestedAt: '2026-10-29T12:00:00.000Z',
}

function applyDeps(verification: PreferenceLinkVerification) {
	return {
		verify: vi.fn(async () => verification),
		verifyWithKit: vi.fn(async () => 'kit-only@example.test' as string | null),
		syncLocal: vi.fn(async () => undefined),
		recordOptOut: vi.fn(async () => undefined),
		writeKit: vi.fn(async () => undefined),
	}
}

describe('applyEmailPreferenceChange', () => {
	it('a page-verified opt-out records the stop and writes Kit, without reverifying', async () => {
		const deps = applyDeps(verified)
		await expect(
			applyEmailPreferenceChange(
				{ ...change, email: 'reader@example.test', localSynced: true },
				deps,
			),
		).resolves.toEqual({ status: 'applied', verifiedBy: 'page' })
		expect(deps.verify).not.toHaveBeenCalled()
		expect(deps.syncLocal).not.toHaveBeenCalled()
		expect(deps.recordOptOut).toHaveBeenCalledWith('reader@example.test')
		expect(deps.writeKit).toHaveBeenCalledWith('reader@example.test')
	})

	it('a queued opt-out verifies against the directory first', async () => {
		const deps = applyDeps(verified)
		await expect(applyEmailPreferenceChange(change, deps)).resolves.toEqual({
			status: 'applied',
			verifiedBy: 'directory',
		})
		expect(deps.syncLocal).toHaveBeenCalledWith('reader@example.test')
		expect(deps.verifyWithKit).not.toHaveBeenCalled()
	})

	it('a directory outage throws so Inngest retries, and writes nothing', async () => {
		const deps = applyDeps({
			status: 'unverifiable',
			reason: 'directory-unavailable',
		})
		await expect(applyEmailPreferenceChange(change, deps)).rejects.toThrow()
		expect(deps.recordOptOut).not.toHaveBeenCalled()
		expect(deps.writeKit).not.toHaveBeenCalled()
	})

	it('a Kit id the directory does not hold yet verifies with Kit off the page', async () => {
		const deps = applyDeps({ status: 'unverifiable', reason: 'unknown-id' })
		await expect(applyEmailPreferenceChange(change, deps)).resolves.toEqual({
			status: 'applied',
			verifiedBy: 'kit',
		})
		expect(deps.recordOptOut).toHaveBeenCalledWith('kit-only@example.test')
	})

	it('a tampered link is dropped', async () => {
		const deps = applyDeps({ status: 'invalid', reason: 'hash-mismatch' })
		await expect(applyEmailPreferenceChange(change, deps)).resolves.toEqual({
			status: 'dropped',
			reason: 'invalid-link',
		})
		expect(deps.writeKit).not.toHaveBeenCalled()
	})

	it('an unverified opt-in is never applied', async () => {
		const deps = applyDeps(verified)
		await expect(
			applyEmailPreferenceChange({ ...change, subscribed: true }, deps),
		).resolves.toEqual({ status: 'dropped', reason: 'unverified-opt-in' })
		expect(deps.verify).not.toHaveBeenCalled()
		expect(deps.writeKit).not.toHaveBeenCalled()
	})
})

describe('readLocalEmailPreferences', () => {
	const evidence = (overrides: {
		stops?: { reason: string }[]
		events?: {
			eventType: string
			providerReference?: string
			occurredAt: string
		}[]
		rows?: [string, { active: boolean; updatedAt: string }][]
	}) => ({
		readDrovrStops: async () => overrides.stops ?? [],
		readContactEvents: async () => overrides.events ?? [],
		readPreferenceRows: async () => new Map(overrides.rows ?? []),
	})

	const optOut = (key: string, at: string) => ({
		eventType: 'contact.unsubscribed',
		providerReference: `kit:email-preference:${key}`,
		occurredAt: at,
	})

	it('defaults to subscribed with no evidence', async () => {
		const state = await readLocalEmailPreferences(verified, evidence({}))
		expect(state.newsletter).toEqual({
			known: true,
			subscribed: true,
			stoppedEverything: false,
		})
	})

	it('a scoped opt-out stops only its preference', async () => {
		const state = await readLocalEmailPreferences(
			verified,
			evidence({ events: [optOut('ai-skills', '2026-10-01T00:00:00Z')] }),
		)
		expect(state['ai-skills']).toMatchObject({ known: true, subscribed: false })
		expect(state.newsletter).toMatchObject({ known: true, subscribed: true })
	})

	it("the reader's later opt-in on this page lifts a scoped opt-out", async () => {
		const state = await readLocalEmailPreferences(
			verified,
			evidence({
				events: [optOut('ai-skills', '2026-10-01T00:00:00Z')],
				rows: [
					[
						'AI Skills Updates',
						{ active: true, updatedAt: '2026-10-02T00:00:00Z' },
					],
				],
			}),
		)
		expect(state['ai-skills']).toMatchObject({ subscribed: true })
	})

	it('a stop wins a tie with an opt-in', async () => {
		const state = await readLocalEmailPreferences(
			verified,
			evidence({
				events: [optOut('ai-skills', '2026-10-01T00:00:00Z')],
				rows: [
					[
						'AI Skills Updates',
						{ active: true, updatedAt: '2026-10-01T00:00:00Z' },
					],
				],
			}),
		)
		expect(state['ai-skills']).toMatchObject({ subscribed: false })
	})

	it('an opt-in row with an unreadable time lifts nothing', async () => {
		const state = await readLocalEmailPreferences(
			verified,
			evidence({
				events: [optOut('newsletter', '2026-10-01T00:00:00Z')],
				rows: [['Newsletter', { active: true, updatedAt: '' }]],
			}),
		)
		expect(state.newsletter).toMatchObject({ subscribed: false })
	})

	it('a drovr all-scope stop wins over every local opt-in', async () => {
		const state = await readLocalEmailPreferences(
			verified,
			evidence({
				stops: [{ reason: 'unsubscribed' }],
				rows: [
					['Newsletter', { active: true, updatedAt: '2026-10-02T00:00:00Z' }],
				],
			}),
		)
		expect(state.newsletter).toEqual({
			known: true,
			subscribed: false,
			stoppedEverything: true,
		})
	})

	it('any failed read leaves every preference unknown', async () => {
		const state = await readLocalEmailPreferences(verified, {
			...evidence({}),
			readDrovrStops: async () => {
				throw new Error('drovr 503')
			},
		})
		expect(state.newsletter).toEqual({ known: false })
		expect(state['ai-skills']).toEqual({ known: false })
	})

	it('an unverified link reads nothing and stays unknown', async () => {
		const readDrovrStops = vi.fn(async () => [])
		const state = await readLocalEmailPreferences(
			{ status: 'unverifiable', reason: 'unknown-id' },
			{ ...evidence({}), readDrovrStops },
		)
		expect(state.newsletter).toEqual({ known: false })
		expect(readDrovrStops).not.toHaveBeenCalled()
	})
})
