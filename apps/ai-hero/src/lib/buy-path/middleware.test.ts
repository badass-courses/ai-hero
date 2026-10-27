import { beforeEach, describe, expect, it, vi } from 'vitest'
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
	readPurchaseBuyPathContext: mocks.read,
}))
vi.mock('@/lib/buy-path/server', () => ({ emitBuyPath: mocks.emit }))
vi.mock('@/lib/buy-path/legacy-logger', () => ({
	installBuyPathLegacyAliases: vi.fn(),
}))
import '@/inngest/inngest-telemetry-middleware'
describe('purchase lifecycle telemetry', () => {
	beforeEach(() => {
		mocks.read.mockReset()
		mocks.emit.mockReset()
		mocks.info.mockClear()
		mocks.error.mockClear()
	})
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
		mocks.read.mockResolvedValue({ reason: 'checkout', context })
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

	it.each(['no-merchant-session', 'not-checkout-session', 'missing-charge'])(
		'logs %s at info only on a final response, not on step executions',
		async (reason) => {
			const config = mocks.register.mock.calls[0]![0]
			mocks.read.mockResolvedValue({ reason, context: null })
			const input = {
				ctx: {
					event: { name: 'purchase', data: { purchaseId: 'purchase_fixture' } },
					runId: 'run_fixture',
				},
				fn: { name: 'fixture', id: () => 'fixture' },
			}
			for (let step = 0; step < 155; step++) {
				const hooks = await config.init().onFunctionRun(input)
				await hooks.beforeExecution()
				if (step === 154) await hooks.finished({ result: {} })
			}
			expect(mocks.error).not.toHaveBeenCalled()
			expect(
				mocks.info.mock.calls.filter(
					([event]) => event === 'buy_path.context_unavailable',
				),
			).toEqual([
				[
					'buy_path.context_unavailable',
					expect.objectContaining({
						reason,
						functionId: 'fixture',
						runId: 'run_fixture',
					}),
				],
			])
		},
	)

	it('retains error level for a thrown read, only on the final response', async () => {
		const config = mocks.register.mock.calls[0]![0]
		mocks.read.mockResolvedValue({
			reason: 'threw',
			context: null,
			error: new TypeError('read failed'),
		})
		const hooks = await config.init().onFunctionRun({
			ctx: {
				event: { name: 'purchase', data: { purchaseId: 'purchase_fixture' } },
				runId: 'run_fixture',
			},
			fn: { name: 'fixture', id: () => 'fixture' },
		})
		await hooks.beforeExecution()
		expect(mocks.error).not.toHaveBeenCalled()
		await hooks.finished({ result: {} })
		expect(mocks.error).toHaveBeenCalledOnce()
		expect(mocks.error).toHaveBeenCalledWith(
			'buy_path.context_read_failed',
			expect.objectContaining({ reason: 'threw', functionId: 'fixture' }),
		)
	})

	it('logs failures from the supported finished hook, including empty errors', async () => {
		const config = mocks.register.mock.calls[0]![0]
		const hooks = await config.init().onFunctionRun({
			ctx: { event: { name: 'fixture', data: {} }, runId: 'run_fixture' },
			fn: { name: 'fixture', id: () => 'function_fixture' },
		})
		expect(hooks).not.toHaveProperty('onFailure')
		await hooks.finished({
			result: { error: { name: '', message: '' } as Error },
		})
		expect(mocks.error).toHaveBeenCalledOnce()
		expect(mocks.error).toHaveBeenCalledWith(
			'inngest.function.failed',
			expect.objectContaining({
				functionId: 'function_fixture',
				runId: 'run_fixture',
				errorClass: 'Error',
				message: 'Inngest function failed',
			}),
		)
	})

	it('does not log function failures on successful final responses', async () => {
		const config = mocks.register.mock.calls[0]![0]
		const hooks = await config.init().onFunctionRun({
			ctx: { event: { name: 'fixture', data: {} }, runId: 'run_fixture' },
			fn: { name: 'fixture', id: () => 'function_fixture' },
		})
		await hooks.finished({ result: {} })
		expect(mocks.error).not.toHaveBeenCalled()
	})
})
