import { expect, it, vi } from 'vitest'
import { getLogContext, log, withLogContext } from '@/server/logger'

// Exercise the actual logger/context storage, not a mocked logger facade.
// Disable direct Axiom ingest so this test cannot call a transport.
vi.mock('@/env.mjs', () => ({ env: { NODE_ENV: 'test' } }))

it('park logging replaces ambient context across awaits and restores the outer scope', async () => {
	const before = getLogContext()
	const outer = {
		requestId: 'synthetic-private-request',
		email: 'synthetic+context@example.test',
	}
	const business = {
		alertId: 'straggler-parked:synthetic-generation',
		contactId: 'synthetic-contact',
		refusalCode: 'event-not-live',
		eventTypes: ['contact.profile.updated'],
		attempts: 1,
		firstAttemptAt: '2032-01-01T00:00:00Z',
		parkedAt: '2032-01-08T00:00:00Z',
	}
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		await withLogContext(outer, async () => {
			expect(getLogContext()).toBe(outer)
			await withLogContext({}, async () => {
				await Promise.resolve()
				expect(getLogContext()).toEqual({})
				await log.warn('aih.drovr_sync.parked', business)
			})
			expect(getLogContext()).toBe(outer)
		})
		expect(getLogContext()).toBe(before)
		expect(warn).toHaveBeenCalledOnce()
		const serialized = String(warn.mock.calls[0]![0]),
			entry = JSON.parse(serialized)
		expect(entry.context).toEqual({})
		expect(serialized).not.toContain(outer.email)
		expect(serialized).not.toContain(outer.requestId)
		const fields = Object.fromEntries(
			Object.entries(entry).filter(
				([key]) => !['_time', 'level', 'event', 'context'].includes(key),
			),
		)
		expect(fields).toEqual(business)
	} finally {
		warn.mockRestore()
	}
})
