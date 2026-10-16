import { describe, expect, it, vi } from 'vitest'
type Context = {
	event: { name: string; data: Record<string, unknown> }
	runId: string
}
type Hooks = {
	transformInput(input: { ctx: Context }): void
	beforeExecution(): Promise<void>
	finished(input: { result: { error?: Error } }): Promise<void>
}
type Config = {
	init(): {
		onFunctionRun(input: {
			ctx: Context
			fn: { name: string; id(name: string): string }
		}): Promise<Hooks>
	}
}
const mocks = vi.hoisted(() => ({
	register: vi.fn<[Config], void>(),
	read: vi.fn(),
	emit: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
}))
vi.mock('inngest', () => ({
	InngestMiddleware: class {
		constructor(config: Config) {
			mocks.register(config)
		}
	},
}))
vi.mock('@/server/logger', () => ({
	log: { info: mocks.info, error: mocks.error },
	serializeError: vi.fn(),
}))
vi.mock('@/lib/buy-path/read-context', () => ({
	purchaseBuyPathContext: mocks.read,
}))
vi.mock('@/lib/buy-path/server', () => ({ emitBuyPath: mocks.emit }))
vi.mock('@/lib/buy-path/legacy-logger', () => ({
	installBuyPathLegacyAliases: vi.fn(),
}))
import '@/inngest/inngest-telemetry-middleware'
describe('purchase lifecycle telemetry', () => {
	it('resolves purchase identity from hydrated input rather than partial initial metadata', async () => {
		const config = mocks.register.mock.calls[0]?.[0]
		if (!config) throw Error('Middleware not registered')
		const ctx = {
			event: { name: 'commerce/new-purchase-created', data: {} },
			runId: 'run_fixture',
		}
		const hooks = await config.init().onFunctionRun({
			ctx,
			fn: { name: 'fixture', id: () => 'post-purchase-workflow' },
		})
		const context = {
			buyPathId: 'cs_test_fixture',
			purchaseId: 'purchase_fixture',
			productId: 'product_fixture',
			userId: null,
		}
		mocks.read.mockResolvedValue(context)
		await hooks.transformInput({
			ctx: {
				...ctx,
				event: { ...ctx.event, data: { purchaseId: 'purchase_fixture' } },
			},
		})
		await hooks.beforeExecution()
		await hooks.finished({ result: {} })
		expect(mocks.read).toHaveBeenCalledWith('purchase_fixture')
		expect(mocks.emit).toHaveBeenCalledWith(
			context,
			'post_purchase_started',
			expect.objectContaining({ runId: 'run_fixture' }),
		)
		expect(mocks.emit).toHaveBeenCalledWith(
			context,
			'post_purchase_finished',
			expect.objectContaining({ outcome: 'ok' }),
		)
	})
})
