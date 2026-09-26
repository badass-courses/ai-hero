import { describe, expect, it, vi } from 'vitest'

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: vi.fn(() => ({})) },
}))

const { reconcileContactSync } = await import('./drovr-contact-sync-reconcile')

function harness(
	overrides: {
		env?: Record<string, string>
		configured?: boolean
	} = {},
) {
	const order: string[] = []
	const step = {
		run: vi.fn(async (id: string, callback: () => Promise<unknown>) => {
			order.push(id)
			return callback()
		}),
		invoke: vi.fn(async (id: string) => {
			order.push(id)
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
						rejected: 0,
						discarded: 2,
					}
		}),
	}
	const error = vi.fn()
	const heartbeat = vi.fn(async () => ({ advanced: true }))
	const writeWatermark = vi.fn(async () => undefined)
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
					},
					{
						id: 'e2',
						contactId: 'c2',
						eventType: 'contact.unsubscribed',
						occurredAt: '2026-09-26T17:51:00.000Z',
					},
				],
				rotatedContacts: async () => [],
				writeWatermark,
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
	return { run, step, order, error, heartbeat, writeWatermark }
}

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
			'scan-changes',
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
	})
})
