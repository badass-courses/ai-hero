import { describe, expect, it, vi } from 'vitest'
import { DROVR_CONTACT_PROFILE_SYNC_EVENT } from '@/inngest/events/drovr'
import { inngest } from '@/inngest/inngest.server'

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: vi.fn(() => ({})) },
}))

await import('./drovr-profile-restatement-sweep')
await import('./drovr-contact-profile-sync')

describe('profile re-statement scheduling', () => {
	it('registers a daily cron with no overlapping sweep runs', () => {
		expect(inngest.createFunction).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'drovr-profile-restatement-sweep-v1',
				concurrency: [{ limit: 1 }],
			}),
			{ cron: '0 6 * * *' },
			expect.any(Function),
		)
	})

	it('fans into the existing event-triggered sync with per-contact concurrency', () => {
		expect(inngest.createFunction).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'drovr-contact-profile-sync-v1',
				concurrency: [{ key: 'event.data.contactId', limit: 1 }],
			}),
			{ event: DROVR_CONTACT_PROFILE_SYNC_EVENT },
			expect.any(Function),
		)
	})
})
