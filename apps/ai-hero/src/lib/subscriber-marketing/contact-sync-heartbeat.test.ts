import { describe, expect, it, vi } from 'vitest'

import {
	contactSyncHeartbeatUrl,
	postContactSyncHeartbeat,
} from './contact-sync-heartbeat'

const config = { ingestUrl: 'https://drovr.test/events', apiKey: 'test-key' }
const syncedThrough = '2026-09-26T17:58:00.000Z'

describe('contact sync heartbeat', () => {
	it('sits beside the ingest route', () => {
		expect(contactSyncHeartbeatUrl('https://drovr.test/events')).toBe(
			'https://drovr.test/contact-sync/heartbeat',
		)
		expect(contactSyncHeartbeatUrl('https://drovr.test/events/')).toBe(
			'https://drovr.test/contact-sync/heartbeat',
		)
		expect(contactSyncHeartbeatUrl('https://api.drovr.test/v1/events')).toBe(
			'https://api.drovr.test/v1/contact-sync/heartbeat',
		)
	})

	it('posts exactly {syncedThrough} under the tenant key and accepts an equal watermark', async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					advanced: false,
					heartbeatAt: '2026-09-26T18:00:01.000Z',
					syncedThrough,
					tenantId: 'org-aihero',
				}),
				{ status: 200 },
			),
		)
		await expect(
			postContactSyncHeartbeat({ config, syncedThrough, fetcher }),
		).resolves.toEqual({ advanced: false })
		expect(fetcher).toHaveBeenCalledWith(
			'https://drovr.test/contact-sync/heartbeat',
			expect.objectContaining({
				method: 'POST',
				headers: {
					authorization: 'Bearer test-key',
					'content-type': 'application/json',
				},
				body: JSON.stringify({ syncedThrough }),
			}),
		)
	})

	it('throws on anything but 200, so the watermark does not advance', async () => {
		for (const status of [201, 401, 404, 409, 500, 503]) {
			const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status }))
			await expect(
				postContactSyncHeartbeat({ config, syncedThrough, fetcher }),
			).rejects.toThrow(`heartbeat answered ${status}`)
		}
		await expect(
			postContactSyncHeartbeat({
				config,
				syncedThrough,
				fetcher: vi.fn().mockRejectedValue(new Error('socket hang up')),
			}),
		).rejects.toThrow('socket hang up')
	})
})
