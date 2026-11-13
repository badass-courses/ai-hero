import { describe, expect, it, vi } from 'vitest'
import { DROVR_CONTACT_PROFILE_SYNC_EVENT } from '@/inngest/events/drovr'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'
import {
	contactProfileContentHash,
	runContactProfileSync,
	type ContactProfileSnapshot,
} from './drovr-contact-profile-sync'
import { runProfileRestatementSweep } from './drovr-profile-restatement-sweep'

type SweepArgs = Parameters<typeof runProfileRestatementSweep>[0]
type SweepEvent = Parameters<SweepArgs['step']['sendEvent']>[1][number]
const startedAt = '2026-10-10T12:00:00.000Z'

function harness(contacts = ['quiet-contact']) {
	const sent: SweepEvent[][] = []
	const store = { listDue: vi.fn(async () => contacts) }
	const step = {
		run: vi.fn(async (_id: string, cb: () => Promise<unknown>) => cb()),
		sendEvent: vi.fn(async (_id: string, events: SweepEvent[]) => {
			sent.push(events)
		}),
	}
	const args: SweepArgs = {
		env: { AIH_DROVR_PROFILE_SYNC: 'true' },
		configured: true,
		startedAt,
		store,
		step,
	}
	return { args, store, step, sent }
}

describe('daily profile re-statement sweep', () => {
	it('skips selection and dispatch while the gate is off', async () => {
		const h = harness()
		await expect(
			runProfileRestatementSweep({ ...h.args, env: {} }),
		).resolves.toMatchObject({ status: 'skipped' })
		expect(h.store.listDue).not.toHaveBeenCalled()
		expect(h.step.sendEvent).not.toHaveBeenCalled()
	})

	it('skips when drovr is not configured', async () => {
		const h = harness()
		await expect(
			runProfileRestatementSweep({ ...h.args, configured: false }),
		).resolves.toEqual({ status: 'skipped', reason: 'drovr-not-configured' })
		expect(h.store.listDue).not.toHaveBeenCalled()
		expect(h.step.sendEvent).not.toHaveBeenCalled()
	})

	it('uses a seven-day cutoff and dispatches the default cap in fifteen batches, not per-contact invokes', async () => {
		const h = harness(Array.from({ length: 1500 }, (_, i) => `contact-${i}`))
		await expect(runProfileRestatementSweep(h.args)).resolves.toEqual({
			status: 'queued',
			contacts: 1500,
		})
		expect(h.store.listDue).toHaveBeenCalledWith({
			before: '2026-10-03T12:00:00.000Z',
			limit: 1500,
		})
		expect(h.step.run).toHaveBeenCalledOnce()
		expect(h.step.sendEvent).toHaveBeenCalledTimes(15)
		expect(h.sent.every((batch) => batch.length === 100)).toBe(true)
		expect(h.sent.flat().map((event) => event.data.contactId)).toEqual(
			Array.from({ length: 1500 }, (_, i) => `contact-${i}`),
		)
		expect(h.sent[0]![0]).toEqual({
			id: `drovr-profile-restatement:${startedAt}:contact-0`,
			name: DROVR_CONTACT_PROFILE_SYNC_EVENT,
			data: { contactId: 'contact-0', reason: 'reconcile' },
		})
	})

	it('sends a final partial batch and no batch for an empty selection', async () => {
		const h = harness(Array.from({ length: 101 }, (_, i) => `c-${i}`))
		await runProfileRestatementSweep(h.args)
		expect(h.sent.map((batch) => batch.length)).toEqual([100, 1])
		const empty = harness([])
		await expect(runProfileRestatementSweep(empty.args)).resolves.toEqual({
			status: 'queued',
			contacts: 0,
		})
		expect(empty.step.sendEvent).not.toHaveBeenCalled()
	})

	it('dispatches a reason that reaches the existing profile-only re-statement branch for a quiet contact', async () => {
		const h = harness()
		await runProfileRestatementSweep(h.args)
		const event = h.sent[0]![0]!
		const snapshot: ContactProfileSnapshot = {
			occurredAt: startedAt,
			profile: { email: 'quiet@example.test', firstName: null, holds: [] },
			links: [],
			offers: [],
		}
		const store = createMemoryContactProfileVersionStore({
			now: () => '2026-09-01T12:00:00.000Z',
		})
		await store.versionFor(
			event.data.contactId,
			contactProfileContentHash(snapshot),
		)
		await store.acknowledge(event.data.contactId, 1)
		const deliver = vi.fn(async () => ({ accepted: 1, rejected: 0 }))
		await expect(
			runContactProfileSync({
				event,
				step: { run: h.step.run, sendEvent: async () => undefined },
				env: h.args.env,
				readSnapshot: async () => snapshot,
				versionFor: store.versionFor,
				acknowledge: store.acknowledge,
				deliver,
				ownedPath: async () => undefined,
				onSendingJourney: async () => true,
				birth: async () => undefined,
				now: () => Date.parse(startedAt),
			}),
		).resolves.toMatchObject({
			status: 'sent',
			profileVersion: 1,
			links: 0,
			offers: 0,
		})
		expect(deliver).toHaveBeenCalledWith([
			expect.objectContaining({
				type: 'contact.profile.updated',
				occurredAt: startedAt,
				idempotencyKey: expect.stringMatching(/^profile:quiet-contact:1:r\d+$/),
			}),
		])
	})
})
