import { describe, expect, it, vi } from 'vitest'

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: vi.fn(() => ({})) },
}))

const { reconcileContactSync, stopBatchKey } =
	await import('./drovr-contact-sync-reconcile')

// Stop steps carry a per-batch key; the order checks below read the step name.
const stepName = (id: string) =>
	id.replace(/^(load-stops|resend-stops):[0-9a-f]{16}$/, '$1')

function harness(
	overrides: {
		env?: Record<string, string>
		configured?: boolean
		stopsRejected?: number
		ownerStopsNeverBorn?: number
		lateCursor?: {
			after?: { createdAt: string; id: string }
			failing?: { contactId: string; runs: number }
		}
		failSync?: string
	} = {},
) {
	const order: string[] = []
	const step = {
		run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
			order.push(stepName(id))
			return callback()
		}),
		invoke: vi.fn(async (id: string) => {
			order.push(stepName(id))
			if (id === `sync:${overrides.failSync}`) throw new Error('drovr 503')
			return id.startsWith('sync:')
				? {
						status: 'sent',
						profileVersion: 2,
						links: 0,
						offers: 0,
						accepted: 1,
						rejected: 0,
					}
				: {
						status: 'delivered',
						accepted: 2,
						rejected: overrides.stopsRejected ?? 0,
						discarded: 2,
						...(overrides.ownerStopsNeverBorn === undefined
							? {}
							: { ownerStopsNeverBorn: overrides.ownerStopsNeverBorn }),
					}
		}),
	}
	const error = vi.fn()
	const heartbeat = vi.fn(async () => ({ advanced: true }))
	const writeWatermark = vi.fn(async () => undefined)
	const writeLateCursor = vi.fn(async () => undefined)
	const run = () =>
		reconcileContactSync({
			// A fake with the two tools the run uses.
			step: step as never,
			env: overrides.env ?? { AIH_DROVR_PROFILE_SYNC: 'true' },
			configured: overrides.configured ?? true,
			error,
			store: {
				readWatermark: async () => '2026-09-26T17:40:00.000Z',
				scanChanges: async () => [
					{
						id: 'e1',
						contactId: 'c1',
						eventType: 'skills-newsletter.subscribed',
						occurredAt: '2026-09-26T17:50:00.000Z',
						createdAt: '2026-09-26T17:50:00.000Z',
					},
					{
						id: 'e2',
						contactId: 'c2',
						eventType: 'contact.unsubscribed',
						occurredAt: '2026-09-26T17:51:00.000Z',
						createdAt: '2026-09-26T17:51:00.000Z',
					},
				],
				rotatedContacts: async () => [],
				writeWatermark,
				readLateCursor: async () => overrides.lateCursor,
				writeLateCursor,
			},
			stopFacts: async () => [
				{
					tenantId: 'org-aihero-shadow',
					contactId: 'c2',
					journeyId: 'value-path-skills-course',
					type: 'contact.unsubscribed',
					occurredAt: '2026-09-26T17:51:00.000Z',
					idempotencyKey: 'k2',
				},
			],
			heartbeat,
			startedAt: '2026-09-26T18:00:00.000Z',
		})
	return {
		run,
		step,
		order,
		error,
		heartbeat,
		writeWatermark,
		writeLateCursor,
	}
}

describe('stop re-send step ids (sec-046)', () => {
	it('keys a batch by its rows, in any order', () => {
		expect(stopBatchKey([{ id: 'a' }, { id: 'b' }])).toBe(
			stopBatchKey([{ id: 'b' }, { id: 'a' }]),
		)
		expect(stopBatchKey([{ id: 'a' }])).not.toBe(stopBatchKey([{ id: 'b' }]))
		expect(stopBatchKey([{ id: 'a' }])).toMatch(/^[0-9a-f]{16}$/)
	})

	it('names both stop steps for the batch they send', async () => {
		const h = harness()
		await h.run()
		const ids = [
			...h.step.run.mock.calls.map((call) => call[0]),
			...h.step.invoke.mock.calls.map((call) => call[0]),
		].filter((id) => /stops/.test(id))
		expect(ids).toHaveLength(2)
		const [load, resend] = ids
		expect(load).toMatch(/^load-stops:[0-9a-f]{16}$/)
		expect(resend).toBe(load!.replace('load-stops', 'resend-stops'))
	})

	it('a second, different batch in one run is not served the first batch result', async () => {
		// A memoizing step, as Inngest replays it: same id, same answer.
		const memo = new Map<string, unknown>()
		const sent: unknown[] = []
		const step = {
			run: async (id: string, callback: () => Promise<unknown>) => {
				if (!memo.has(id)) memo.set(id, await callback())
				return memo.get(id)
			},
			invoke: async (id: string, opts: { data: { events: unknown[] } }) => {
				if (!memo.has(id)) {
					sent.push(...opts.data.events)
					memo.set(id, { status: 'delivered', accepted: 1, rejected: 0 })
				}
				return memo.get(id)
			},
		}
		const ids = [stopBatchKey([{ id: 'x' }]), stopBatchKey([{ id: 'y' }])]
		for (const [i, key] of ids.entries()) {
			const events = await step.run(`load-stops:${key}`, async () => [
				`event-${i}`,
			])
			await step.invoke(`resend-stops:${key}`, {
				data: { events: events as unknown[] },
			})
		}
		expect(sent).toEqual(['event-0', 'event-1'])
	})
})

describe('drovr contact sync reconcile function', () => {
	it('does nothing while the flag is off', async () => {
		const h = harness({ env: {} })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'AIH_DROVR_PROFILE_SYNC is not set',
		})
		expect(h.step.run).not.toHaveBeenCalled()
		expect(h.step.invoke).not.toHaveBeenCalled()
	})

	it('refuses loudly, and never heartbeats, when drovr is not configured', async () => {
		const h = harness({ configured: false })
		await expect(h.run()).resolves.toEqual({
			status: 'skipped',
			reason: 'drovr-not-configured',
		})
		expect(h.error).toHaveBeenCalledWith(
			'drovr.contact_sync.not_configured',
			expect.any(Object),
		)
		expect(h.heartbeat).not.toHaveBeenCalled()
	})

	it('invokes each sync and the stop re-send, then heartbeats, then advances', async () => {
		const h = harness()
		await expect(h.run()).resolves.toMatchObject({
			status: 'synced',
			syncedThrough: '2026-09-26T17:58:00.000Z',
			contacts: 2,
		})
		expect(h.order).toEqual([
			'read-watermark',
			'read-late-cursor',
			'scan-fresh',
			'scan-overlap',
			'rotated-contacts',
			'sync:c1',
			'sync:c2',
			'load-stops',
			'resend-stops',
			'heartbeat',
			'write-watermark',
		])
		expect(h.heartbeat).toHaveBeenCalledWith('2026-09-26T17:58:00.000Z')
		expect(h.writeWatermark).toHaveBeenCalledWith(
			'2026-09-26T17:58:00.000Z',
			expect.any(String),
		)
		expect(h.writeLateCursor).not.toHaveBeenCalled()
	})

	it('never heartbeats past a stop drovr refused', async () => {
		const h = harness({ stopsRejected: 1 })
		await expect(h.run()).rejects.toThrow(/stop re-send was not delivered/)
		expect(h.heartbeat).not.toHaveBeenCalled()
		expect(h.writeWatermark).not.toHaveBeenCalled()
	})

	it('advances past owner-copy stops drovr says never started the journey', async () => {
		// The directory stop landed; the copy to a journey the contact never
		// joined cannot, and re-sending it every run wedged the watermark.
		const h = harness({ stopsRejected: 2, ownerStopsNeverBorn: 2 })
		await expect(h.run()).resolves.toMatchObject({ status: 'synced' })
		expect(h.heartbeat).toHaveBeenCalled()
		expect(h.writeWatermark).toHaveBeenCalled()
	})

	it('clears a late cursor as one more step, after the watermark', async () => {
		const h = harness({
			lateCursor: {
				after: { createdAt: '2026-09-26T17:30:00.000Z', id: 'e0' },
			},
		})
		await expect(h.run()).resolves.toMatchObject({ status: 'synced' })
		expect(h.order.slice(-3)).toEqual([
			'heartbeat',
			'write-watermark',
			'clear-late-cursor',
		])
		expect(h.writeLateCursor).toHaveBeenCalledWith(undefined)
	})

	it('holds a failing late contact in the late cursor, then refuses', async () => {
		const h = harness({ failSync: 'c1' })
		await expect(h.run()).rejects.toThrow('drovr 503')
		expect(h.order).toContain('write-late-cursor')
		expect(h.writeLateCursor).toHaveBeenCalledWith({
			failing: { contactId: 'c1', runs: 1 },
		})
		expect(h.heartbeat).not.toHaveBeenCalled()
		expect(h.writeWatermark).not.toHaveBeenCalled()
	})

	it('pages a late contact skipped on its third failing run, once, as a step', async () => {
		const h = harness({
			failSync: 'c1',
			lateCursor: { failing: { contactId: 'c1', runs: 2 } },
		})
		// c1's fresh change at 17:50 still holds the claim just before it.
		await expect(h.run()).resolves.toMatchObject({
			status: 'partial',
			syncedThrough: '2026-09-26T17:49:59.999Z',
			lateSkipped: ['c1'],
		})
		expect(h.error).toHaveBeenCalledTimes(1)
		expect(h.error).toHaveBeenCalledWith('drovr.contact_sync.late_skipped', {
			contactId: 'c1',
			eventType: 'skills-newsletter.subscribed',
			reason: 'sync failed 3 runs in a row',
		})
		expect(h.order).toEqual([
			'read-watermark',
			'read-late-cursor',
			'scan-fresh',
			'scan-overlap',
			'rotated-contacts',
			'sync:c1',
			'sync:c2',
			// Recorded only once the stops it passes went out.
			'load-stops',
			'resend-stops',
			'late-skipped:c1',
			'write-late-cursor',
			'heartbeat',
			'write-watermark',
			'clear-late-cursor',
		])
	})

	it('still refuses when any other stop was rejected', async () => {
		const h = harness({ stopsRejected: 2, ownerStopsNeverBorn: 1 })
		await expect(h.run()).rejects.toThrow(
			/stop re-send was not delivered: drovr rejected 1/,
		)
		expect(h.writeWatermark).not.toHaveBeenCalled()
	})
})
