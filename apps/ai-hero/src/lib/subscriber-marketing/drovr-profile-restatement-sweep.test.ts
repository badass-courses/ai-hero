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

function harness(contacts = ['quiet-contact'], cursor?: string) {
	const sent: SweepEvent[][] = []
	const order: string[] = []
	const store = {
		listDue: vi.fn(async (_args: { after?: string }) => contacts),
		readCursor: vi.fn(async () => cursor),
		writeCursor: vi.fn(async (_after: string | undefined) => undefined),
	}
	const step = {
		run: vi.fn(async (_id: string, cb: () => Promise<unknown>) => cb()),
		sendEvent: vi.fn(async (id: string, events: SweepEvent[]) => {
			order.push(id)
			sent.push(events)
		}),
		sleep: vi.fn(async (id: string, _time: string | number) => {
			order.push(id)
		}),
	}
	const args: SweepArgs = {
		env: { AIH_DROVR_PROFILE_SYNC: 'true' },
		configured: true,
		startedAt,
		store,
		step,
	}
	return { args, store, step, sent, order }
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

	it('uses a seven-day cutoff and dispatches the default cap in 150 small batches, not per-contact invokes', async () => {
		const h = harness(Array.from({ length: 1500 }, (_, i) => `contact-${i}`))
		await expect(runProfileRestatementSweep(h.args)).resolves.toEqual({
			status: 'queued',
			contacts: 1500,
			lapEnded: false,
		})
		expect(h.store.listDue).toHaveBeenCalledWith({
			before: '2026-10-03T12:00:00.000Z',
			after: undefined,
			limit: 1500,
		})
		expect(h.step.run).toHaveBeenCalledTimes(3)
		expect(h.step.sendEvent).toHaveBeenCalledTimes(150)
		expect(h.step.sleep).toHaveBeenCalledTimes(149)
		expect(h.step.sleep).toHaveBeenLastCalledWith('restate-pace-148', '12s')
		expect(h.sent.every((batch) => batch.length === 10)).toBe(true)
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
		const h = harness(Array.from({ length: 11 }, (_, i) => `c-${i}`))
		await runProfileRestatementSweep(h.args)
		expect(h.sent.map((batch) => batch.length)).toEqual([10, 1])
		const empty = harness([])
		await expect(runProfileRestatementSweep(empty.args)).resolves.toEqual({
			status: 'queued',
			contacts: 0,
			lapEnded: true,
		})
		expect(empty.step.sendEvent).not.toHaveBeenCalled()
		expect(empty.step.sleep).not.toHaveBeenCalled()
	})

	it('paces 25 contacts as three ordered batches with two pauses and none after the last', async () => {
		const h = harness(Array.from({ length: 25 }, (_, i) => `c-${i}`))
		await runProfileRestatementSweep(h.args)
		expect(h.sent.map((batch) => batch.length)).toEqual([10, 10, 5])
		expect(h.order).toEqual([
			'restate-batch-0',
			'restate-pace-0',
			'restate-batch-1',
			'restate-pace-1',
			'restate-batch-2',
		])
		expect(h.step.sleep.mock.calls).toEqual([
			['restate-pace-0', '12s'],
			['restate-pace-1', '12s'],
		])
	})

	it('walks from the stored cursor and keeps the last id of a full page', async () => {
		const h = harness(['c-3', 'c-4'], 'c-2')
		await runProfileRestatementSweep({ ...h.args, limit: 2 })
		expect(h.store.listDue).toHaveBeenCalledWith(
			expect.objectContaining({ after: 'c-2', limit: 2 }),
		)
		expect(h.store.writeCursor).toHaveBeenCalledWith('c-4')
	})

	it('ends the lap on a short page, so contacts the sync skips cannot starve the rest', async () => {
		const h = harness(['c-9'], 'c-8')
		await expect(
			runProfileRestatementSweep({ ...h.args, limit: 2 }),
		).resolves.toMatchObject({ lapEnded: true })
		expect(h.store.writeCursor).toHaveBeenCalledWith(undefined)
		// The cursor is stored before dispatch, so a replay never re-selects.
		expect(h.store.writeCursor.mock.invocationCallOrder[0]).toBeLessThan(
			h.step.sendEvent.mock.invocationCallOrder[0]!,
		)
	})

	it('accepts an injected batch size and pause', async () => {
		const h = harness(['c-0', 'c-1', 'c-2'])
		await runProfileRestatementSweep({ ...h.args, batchSize: 2, pause: '1s' })
		expect(h.sent.map((batch) => batch.length)).toEqual([2, 1])
		expect(h.order).toEqual([
			'restate-batch-0',
			'restate-pace-0',
			'restate-batch-1',
		])
		expect(h.step.sleep).toHaveBeenCalledOnce()
		expect(h.step.sleep).toHaveBeenCalledWith('restate-pace-0', '1s')
	})

	it.each([0, -1, 1.5])(
		'rejects invalid batch size %s without dispatch',
		async (batchSize) => {
			const h = harness()
			await expect(
				runProfileRestatementSweep({ ...h.args, batchSize }),
			).rejects.toThrow('batch size must be a positive integer')
			expect(h.step.sendEvent).not.toHaveBeenCalled()
			expect(h.step.sleep).not.toHaveBeenCalled()
		},
	)

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
