import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
const mocks = vi.hoisted(() => ({
	select: vi.fn(),
	capacityError: vi.fn(async (_name: string, _fields: unknown) => {}),
	update: vi.fn(),
	createFunction: vi.fn((config, trigger, handler) => ({
		config,
		trigger,
		handler,
	})),
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.capacityError } }))
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
	const selection = vi.fn((_clause: unknown) => ({
		orderBy: () => ({ limit }),
	}))
	mocks.select
		.mockReturnValueOnce({ from: async () => [{ total: 3000 }] })
		.mockReturnValueOnce({
			from: () => ({ where: selection }),
		})
	const where = vi.fn(async () => undefined)
	const set = vi.fn((_values: Record<string, unknown>) => ({ where }))
	mocks.update.mockReturnValue({ set })
	const step = {
		run: async (_id: string, fn: () => Promise<unknown>) => fn(),
		invoke: vi.fn(async () => receipt),
	}
	return { step, limit, set, selection }
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
	expect(
		new MySqlDialect().sqlToQuery(h.selection.mock.calls[0]![0] as SQL).sql,
	).toMatch(/`acknowledgedVersion` = .*`profileVersion`/)
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
it('never fabricates confirmation age to defer a proofless out-of-scope contact', async () => {
	const h = harness({ status: 'skipped', reason: 'no-sending-journey' })
	await registered.handler({ step: h.step })
	expect(h.set).not.toHaveBeenCalled()
	expect(mocks.update).not.toHaveBeenCalled()
	// Separate N13 selection fairness is still required. A CURRENT_TIMESTAMP
	// write is not a legitimate implementation of that scheduling policy.
})
it('matching legacy hash migration remains due for an equal-version confirmation', async () => {
	const h = harness({ status: 'skipped', reason: 'hash-migrated' })
	await registered.handler({ step: h.step })
	expect(h.set).not.toHaveBeenCalled()
})
it('emits a dedicated capacity alert and fails terminally without claiming to page', async () => {
	mocks.select.mockReturnValueOnce({ from: async () => [{ total: 999999999 }] })
	const step = {
		run: async (_id: string, action: () => Promise<unknown>) => action(),
	}
	await expect(registered.handler({ step })).rejects.toMatchObject({
		name: 'NonRetriableError',
	})
	expect(mocks.capacityError).toHaveBeenCalledWith(
		'drovr.restate.capacity_exceeded',
		{
			population: 999999999,
			contactsPerTick: 133,
			monthlyCapacity: 133 * 30 * 24 * 4,
		},
	)
})
it('a delivery failure never advances the confirmation rotation', async () => {
	const h = harness({ status: 'skipped', reason: 'drovr-not-configured' })
	await expect(registered.handler({ step: h.step })).rejects.toThrow(
		'RestatementDelivery:',
	)
	expect(h.set).not.toHaveBeenCalled()
})
