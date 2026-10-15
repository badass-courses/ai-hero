import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	select: vi.fn(),
	update: vi.fn(),
	createFunction: vi.fn((config, trigger, handler) => ({
		config,
		trigger,
		handler,
	})),
}))
vi.mock('@/db', () => ({ db: { select: mocks.select, update: mocks.update } }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('./drovr-contact-profile-sync', () => ({
	drovrContactProfileSync: 'profile-function',
}))
import { drovrContactSyncRestate } from './drovr-contact-sync-restate'
const registered = drovrContactSyncRestate as unknown as {
	config: { id: string }
	trigger: { cron: string }
	handler: (args: { step: unknown }) => Promise<unknown>
}
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
})
afterEach(() => {
	vi.unstubAllEnvs()
})

function harness(receipt: unknown = { status: 'sent' }) {
	const limit = vi.fn(async () => [{ contactId: 'contact-a' }])
	mocks.select
		.mockReturnValueOnce({ from: async () => [{ total: 3000 }] })
		.mockReturnValueOnce({
			from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
		})
	const where = vi.fn(async () => undefined)
	const set = vi.fn((_values: Record<string, unknown>) => ({ where }))
	mocks.update.mockReturnValue({ set })
	const step = {
		run: async (_id: string, fn: () => Promise<unknown>) => fn(),
		invoke: vi.fn(async () => receipt),
	}
	return { step, limit, set }
}
it('keeps monthly confirmations separate from the heartbeat function', async () => {
	expect(registered.config.id).toBe('drovr-contact-sync-restate-v1')
	expect(registered.trigger).toEqual({ cron: '7-52/15 * * * *' })
	const h = harness()
	expect(await registered.handler({ step: h.step })).toEqual({
		status: 'queued',
		contacts: 1,
	})
	expect(h.limit).toHaveBeenCalledWith(2)
	expect(h.step.invoke).toHaveBeenCalledWith('restate:contact-a', {
		function: 'profile-function',
		data: { contactId: 'contact-a', reason: 'restate' },
	})
})
it('does no scan while disabled', async () => {
	vi.stubEnv('AIH_DROVR_PROFILE_SYNC', '')
	expect(await registered.handler({ step: {} })).toEqual({ status: 'skipped' })
	expect(mocks.select).not.toHaveBeenCalled()
})
it('does not let an out-of-scope contact monopolize the oldest-first quota', async () => {
	const h = harness({ status: 'skipped', reason: 'no-sending-journey' })
	await registered.handler({ step: h.step })
	expect(Object.keys(h.set.mock.calls[0]![0])).toEqual([
		'acknowledgedAt',
		'updatedAt',
	])
})
it('a delivery failure never advances the confirmation rotation', async () => {
	const h = harness({ status: 'skipped', reason: 'drovr-not-configured' })
	await expect(registered.handler({ step: h.step })).rejects.toThrow(
		'RestatementDelivery:',
	)
	expect(h.set).not.toHaveBeenCalled()
})
