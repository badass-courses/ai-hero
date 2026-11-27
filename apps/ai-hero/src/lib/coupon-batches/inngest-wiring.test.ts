import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
	enabled: vi.fn(() => true),
	runChunk: vi.fn(),
	drainAlerts: vi.fn(),
	warn: vi.fn(async () => {}),
	registrations: new Map<string, unknown>(),
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (
			options: { id: string },
			triggers: object[],
			handler: unknown,
		) => {
			const registered = { ...options, triggers, handler }
			fixture.registrations.set(options.id, registered)
			return registered
		},
	},
}))
vi.mock('@/lib/coupon-batches/runtime', () => ({
	COUPON_BATCH_WAKE: 'commerce/coupon-batches.wake',
	couponBatchEnabled: fixture.enabled,
	couponBatchWorker: () => fixture,
}))
vi.mock('@/server/logger', () => ({ log: { warn: fixture.warn } }))

import '@/inngest/functions/coupon-batch-drain'

function invoke(id: string) {
	const registered = fixture.registrations.get(id) as {
		triggers: object[]
		handler: (input: { step: typeof step }) => Promise<unknown>
	}
	const step = {
		run: async (_id: string, fn: () => unknown) => fn(),
		sleep: vi.fn(),
		sendEvent: vi.fn(),
	}
	expect(registered.triggers).toEqual([
		{ event: 'commerce/coupon-batches.wake' },
		{ cron: '* * * * *' },
	])
	return { result: registered.handler({ step }), step }
}

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

it('includes both registered functions in the served list and runs a paced drain', async () => {
	const location = new URL('../../inngest/inngest.config.ts', import.meta.url)
	const source = ts.createSourceFile(
		'inngest.config.ts',
		readFileSync(location, 'utf8'),
		ts.ScriptTarget.Latest,
		true,
	)
	const declarations = source.statements
		.filter(ts.isVariableStatement)
		.flatMap((s) => [...s.declarationList.declarations])
	const list = declarations.find(
		(d) => d.name.getText(source) === 'allFunctions',
	)?.initializer
	if (!list || !ts.isArrayLiteralExpression(list))
		throw new Error('expected served functions')
	const names = list.elements.map((entry) => entry.getText(source))
	for (const name of ['couponBatchDrain', 'couponBatchAlarms'])
		expect(names.filter((value) => value === name)).toHaveLength(1)
	fixture.runChunk
		.mockResolvedValueOnce({ state: 'worked' })
		.mockResolvedValueOnce({ state: 'paced', waitMs: 1200 })
		.mockResolvedValueOnce({ state: 'idle' })
	const { result, step } = invoke('coupon-batch-drain')
	await expect(result).resolves.toEqual({ state: 'idle' })
	expect(step.sleep).toHaveBeenCalledWith('pace-1', 1200)
})

it('invokes the registered alarm without network and sends a stable dedupe key', async () => {
	const fetchFixture = vi.fn(async () => new Response(null, { status: 204 }))
	vi.stubGlobal('fetch', fetchFixture)
	vi.stubEnv('AIH_COUPON_BATCH_PAGE_URL', 'https://127.0.0.1/fixture-pager')
	vi.stubEnv('AIH_COUPON_BATCH_PAGE_TOKEN', 'fixture-only')
	fixture.drainAlerts.mockImplementationOnce(async (send, log) => {
		const row = {
			id: 'stuck:fixture',
			batchId: 'fixture',
			kind: 'stuck',
			count: 8,
			threshold: 8,
		}
		await log(row)
		await send(row)
		return 1
	})
	await expect(invoke('coupon-batch-alarms').result).resolves.toEqual({
		attempted: 1,
	})
	expect(fetchFixture).toHaveBeenCalledWith(
		'https://127.0.0.1/fixture-pager',
		expect.objectContaining({
			headers: expect.objectContaining({ 'Idempotency-Key': 'stuck:fixture' }),
		}),
	)
	expect(fixture.warn).toHaveBeenCalledWith(
		'coupon_batch.worker_alarm',
		expect.objectContaining({ kind: 'stuck' }),
	)
})
