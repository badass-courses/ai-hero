import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	after: vi.fn(),
	deliver: vi.fn(),
	key: vi.fn(() => 'test-key'),
	baseUrl: vi.fn(() => 'https://drovr.example.test'),
	getUser: vi.fn(),
}))
vi.mock('next/server', () => ({ after: mocks.after }))
vi.mock('./drovr-shadow-emitter', () => ({ drovrApiKeyForTenant: mocks.key }))
vi.mock('./drovr-unsubscribe-page', () => ({
	resolveDrovrApiBaseUrl: mocks.baseUrl,
}))
vi.mock('./product-events', async (original) => ({
	...(await original<typeof import('./product-events')>()),
	deliverProductEvents: mocks.deliver,
}))
vi.mock('@/db', () => ({ courseBuilderAdapter: { getUser: mocks.getUser } }))
import {
	scheduleCheckoutProductEvents,
	scheduleProductEvents,
} from './product-events-live'

const fact = {
	_tag: 'CheckoutStep' as const,
	sessionId: 'cs_test',
	at: 1,
	step: 'started' as const,
}
beforeEach(() => {
	vi.resetAllMocks()
	vi.unstubAllEnvs()
	vi.stubEnv('AIH_DROVR_PRODUCT_EVENTS_ENABLED', 'true')
	mocks.key.mockReturnValue('test-key')
	mocks.baseUrl.mockReturnValue('https://drovr.example.test')
	mocks.deliver.mockResolvedValue('sent')
})

it.each([undefined, 'false', 'TRUE', '1'])(
	'does not schedule or resolve config with flag %s',
	(flag) => {
		if (flag === undefined) delete process.env.AIH_DROVR_PRODUCT_EVENTS_ENABLED
		else vi.stubEnv('AIH_DROVR_PRODUCT_EVENTS_ENABLED', flag)
		scheduleProductEvents(async () => 'test@example.test', [fact])
		expect(mocks.after).not.toHaveBeenCalled()
		expect(mocks.key).not.toHaveBeenCalled()
	},
)
it('never schedules on Vercel preview', () => {
	vi.stubEnv('VERCEL_ENV', 'preview')
	scheduleCheckoutProductEvents(
		{ id: 'cs_test', metadata: { userId: 'user-test' } },
		3,
	)
	expect(mocks.after).not.toHaveBeenCalled()
})
it('defers identity and batches checkout and team-seat intent', async () => {
	mocks.getUser.mockResolvedValue({ email: 'test@example.test' })
	scheduleCheckoutProductEvents(
		{ id: 'cs_test', metadata: { userId: 'user-test' } },
		3,
	)
	expect(mocks.getUser).not.toHaveBeenCalled()
	expect(mocks.deliver).not.toHaveBeenCalled()
	const log = vi.spyOn(console, 'info').mockImplementation(() => {})
	await mocks.after.mock.calls[0]![0]()
	const args = mocks.deliver.mock.calls[0]![0]
	expect(args.facts).toEqual([
		{
			_tag: 'CheckoutStep',
			sessionId: 'cs_test',
			step: 'started',
			at: expect.any(Number),
		},
		{
			_tag: 'TeamIntent',
			sourceId: 'cs_test',
			intent: 'seats',
			at: expect.any(Number),
		},
	])
	expect(await args.email()).toBe('test@example.test')
	expect(mocks.getUser).toHaveBeenCalledWith('user-test')
	expect(log).toHaveBeenCalledWith('drovr.product_events', { outcome: 'sent' })
	log.mockRestore()
})
it('skips anonymous checkout sessions', () => {
	scheduleCheckoutProductEvents({ id: 'cs_test', metadata: null }, 1)
	expect(mocks.after).not.toHaveBeenCalled()
})
it('contains scheduling, config, delivery and logging failures without PII', async () => {
	const log = vi.spyOn(console, 'info').mockImplementation(() => {})
	mocks.after.mockImplementationOnce(() => {
		throw new Error('private')
	})
	expect(() => scheduleProductEvents(async () => null, [fact])).not.toThrow()
	expect(log.mock.calls).toEqual([
		['drovr.product_events', { outcome: 'schedule-failed' }],
	])
	log.mockClear()
	scheduleProductEvents(async () => null, [fact])
	mocks.deliver.mockRejectedValueOnce(new Error('private'))
	await expect(mocks.after.mock.calls[1]![0]()).resolves.toBeUndefined()
	expect(log.mock.calls).toEqual([
		['drovr.product_events', { outcome: 'failed' }],
	])
	log.mockImplementation(() => {
		throw new Error('logger-down')
	})
	mocks.key.mockImplementation(() => {
		throw new Error('private-config')
	})
	await expect(mocks.after.mock.calls[1]![0]()).resolves.toBeUndefined()
	log.mockRestore()
})
