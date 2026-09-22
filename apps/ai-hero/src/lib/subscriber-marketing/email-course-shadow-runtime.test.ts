import { describe, expect, it, vi } from 'vitest'

import type { EmailCourseDatabase } from './email-course-drizzle-ledger'
import { createEmailCourseShadowRuntime } from './email-course-shadow-runtime'

const database = new Proxy(
	{},
	{
		get: () => {
			throw new Error('retired runtime touched the database')
		},
	},
) as EmailCourseDatabase

describe('retired email course shadow runtime', () => {
	it('skips every observation without database, parity, or network work', async () => {
		const fetch = vi.fn()
		const runtime = createEmailCourseShadowRuntime({
			database,
			parity: { fetch },
		})

		await expect(
			runtime.observeSignup({
				contactId: 'contact-1',
				courseEntryEventId: 'entry-1',
				subscribedAt: '2026-09-21T12:00:00.000Z',
			}),
		).resolves.toEqual({
			status: 'skipped',
			reason: 'shadow-runtime-retired',
		})
		await expect(
			runtime.observeDelivery({
				courseEntryEventId: 'entry-1',
				legacyIntentId: 'intent-1',
				emailResourceId: 'resource-1',
				completedAt: '2026-09-21T12:05:00.000Z',
			}),
		).resolves.toEqual({
			status: 'skipped',
			reason: 'shadow-runtime-retired',
		})
		await expect(
			runtime.observeAnswer({
				courseEntryEventId: 'entry-1',
				contactEventId: 'event-1',
				sentEmailResourceId: 'resource-1',
				selectedAt: '2026-09-21T12:10:00.000Z',
			}),
		).resolves.toEqual({
			status: 'skipped',
			reason: 'shadow-runtime-retired',
		})
		expect(fetch).not.toHaveBeenCalled()
	})
})
