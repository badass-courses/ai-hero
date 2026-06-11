import { InngestMiddleware } from 'inngest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { inngestTelemetryMiddleware } from '../inngest-telemetry-middleware'

type TestRunHooks = {
	transformInput?: (args: any) => unknown
	afterExecution?: () => void
	onFailure?: (args: { error: Error }) => void
}

const loggerMocks = vi.hoisted(() => {
	return {
		info: vi.fn(),
		error: vi.fn(),
		serializeError: vi.fn(),
	}
})

vi.mock('@/server/logger', () => ({
	log: {
		info: loggerMocks.info,
		error: loggerMocks.error,
	},
	serializeError: loggerMocks.serializeError,
}))

/**
 * Regression test for 2026-03-22 purchase incident.
 *
 * Root cause: inngest-telemetry-middleware.ts called `steps.run.bind(steps)`
 * inside transformInput, but the Inngest SDK passes `steps` as a raw step
 * state array, not the step tooling object with .run()/.sleep() methods.
 * That made `steps.run` undefined and crashed every function before business
 * logic ran.
 */
function createBrokenTelemetryMiddleware() {
	return new InngestMiddleware({
		name: 'Broken Telemetry Middleware',
		init() {
			return {
				onFunctionRun(_args: any) {
					return {
						transformInput({ ctx: inputCtx, steps }: any) {
							const originalRun = steps.run.bind(steps)

							return {
								ctx: inputCtx,
								steps: {
									...steps,
									run: async (stepId: string, fn: () => Promise<unknown>) => {
										return originalRun(stepId, fn)
									},
								},
							}
						},
					}
				},
			}
		},
	})
}

describe('inngest-telemetry-middleware', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		loggerMocks.info.mockResolvedValue(undefined)
		loggerMocks.error.mockResolvedValue(undefined)
		loggerMocks.serializeError.mockImplementation((error: unknown) => ({
			message: error instanceof Error ? error.message : String(error),
			name: error instanceof Error ? error.name : undefined,
		}))
	})

	it('reproduces the production transformInput crash with step state arrays', async () => {
		const middleware = createBrokenTelemetryMiddleware()
		const initHooks = await middleware.init()
		const runHooks = initHooks.onFunctionRun({
			ctx: {
				runId: 'run_123',
				event: { name: 'test/event', data: {} },
			},
			steps: [],
			fn: { name: 'test function', id: () => 'test' } as any,
			reqArgs: [],
		}) as TestRunHooks

		expect(() => {
			runHooks.transformInput?.({
				ctx: { event: { data: {} } },
				steps: [{ id: 'step-1', data: 'result-1' }],
				fn: {},
				reqArgs: [],
			})
		}).toThrow('Cannot read properties of undefined')
	})

	it('actual middleware does not define transformInput and emits safe function-level logs', async () => {
		const initHooks = (await inngestTelemetryMiddleware.init()) as any
		const runHooks = initHooks.onFunctionRun({
			ctx: {
				runId: 'run_123',
				event: {
					name: 'stripe/checkout-session-completed',
					data: { txnId: 'txn_123' },
				},
			},
			steps: [],
			fn: {
				name: 'checkout handler',
				id: () => 'fn:checkout handler',
			} as any,
			reqArgs: [],
		}) as TestRunHooks

		expect(runHooks.transformInput).toBeUndefined()
		expect(runHooks.afterExecution).toEqual(expect.any(Function))
		expect(runHooks.onFailure).toEqual(expect.any(Function))

		expect(loggerMocks.info).toHaveBeenCalledWith(
			'inngest.function.started',
			expect.objectContaining({
				functionId: 'fn:checkout handler',
				eventName: 'stripe/checkout-session-completed',
				runId: 'run_123',
				txnId: 'txn_123',
			}),
		)

		expect(() => runHooks.afterExecution?.()).not.toThrow()
		expect(loggerMocks.info).toHaveBeenCalledWith(
			'inngest.function.completed',
			expect.objectContaining({
				functionId: 'fn:checkout handler',
				eventName: 'stripe/checkout-session-completed',
				runId: 'run_123',
				txnId: 'txn_123',
			}),
		)

		runHooks.onFailure?.({ error: new Error('boom') })
		expect(loggerMocks.serializeError).toHaveBeenCalledWith(expect.any(Error))
		expect(loggerMocks.error).toHaveBeenCalledWith(
			'inngest.function.failed',
			expect.objectContaining({
				functionId: 'fn:checkout handler',
				eventName: 'stripe/checkout-session-completed',
				runId: 'run_123',
				txnId: 'txn_123',
				error: expect.objectContaining({ message: 'boom' }),
			}),
		)
	})
})
