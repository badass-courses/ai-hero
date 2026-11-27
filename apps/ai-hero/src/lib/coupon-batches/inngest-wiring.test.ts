import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
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
vi.mock('@/lib/coupon-batches/runtime', async (original) => ({
	...(await original<typeof import('./runtime')>()),
	couponBatchWorker: () => fixture,
}))
vi.mock('@/server/logger', () => ({ log: { warn: fixture.warn } }))

import '@/inngest/functions/coupon-batch-drain'

const wake = 'commerce/coupon-batches.wake'

function invoke(
	id: string,
	enqueue: (event: { name: string }) => void = () => {},
	sleep: (id: string, ms: number) => void | Promise<void> = () => {},
) {
	const registered = fixture.registrations.get(id) as {
		triggers: object[]
		concurrency: { limit: number }
		singleton?: { mode: string }
		handler: (input: { step: typeof step }) => Promise<unknown>
	}
	const step = {
		run: async (_id: string, fn: () => unknown) => fn(),
		sleep: vi.fn(sleep),
		sendEvent: vi.fn(async (_id: string, event: { name: string }) => {
			// Inngest drops a wake arriving while a skip singleton is active.
			if (registered.singleton?.mode !== 'skip') enqueue(event)
		}),
	}
	expect(registered.triggers).toEqual([{ event: wake }, { cron: '* * * * *' }])
	expect(registered.concurrency).toEqual({ limit: 1 })
	return { result: registered.handler({ step }), step }
}

beforeEach(() => {
	fixture.runChunk.mockReset()
	vi.stubEnv('AIH_COUPON_BATCH_ENABLED', 'true')
	vi.stubEnv('AIH_COUPON_BATCH_SECRET', '')
})
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

it('drains a 41-chunk backlog from one wake without waiting for cron', async () => {
	let remaining = 41
	fixture.runChunk.mockImplementation(async () =>
		remaining > 0 ? (--remaining, { state: 'worked' }) : { state: 'idle' },
	)
	const queued: string[] = []
	const first = invoke('coupon-batch-drain', ({ name }) => queued.push(name))
	await expect(first.result).resolves.toEqual({ state: 'continued' })
	expect(remaining).toBe(1)
	expect(queued).toEqual([wake])
	await expect(invoke('coupon-batch-drain').result).resolves.toEqual({
		state: 'idle',
	})
	expect(remaining).toBe(0)
	expect(fixture.runChunk).toHaveBeenCalledTimes(42)
})

it('paced cron and admission wakes add no parked runs or continuation events', async () => {
	let nextChunkAt = 0
	let now = 0
	let chunks = 0
	fixture.runChunk.mockImplementation(async () => {
		if (now < nextChunkAt) return { state: 'paced', waitMs: nextChunkAt - now }
		chunks++
		nextChunkAt = now + 60_000
		return { state: 'worked' }
	})
	const queued = vi.fn()
	const parked: (() => void)[] = []
	const sleep = () => new Promise<void>((resolve) => parked.push(resolve))
	let active = invoke('coupon-batch-drain', queued, sleep)
	for (let minute = 0; minute < 3; minute++) {
		// Let the runner that advanced the cursor reach its durable sleep.
		await vi.waitFor(() => expect(parked).toHaveLength(1))
		const extra = Array.from({ length: 4 }, () =>
			invoke('coupon-batch-drain', queued),
		)
		for (const run of extra) {
			await expect(run.result).resolves.toMatchObject({ state: 'paced' })
			expect(run.step.sleep).not.toHaveBeenCalled()
		}
		expect(parked).toHaveLength(1)
		expect(queued).not.toHaveBeenCalled()
		expect(chunks).toBe(minute + 1)
		if (minute < 2) {
			// The next cron wins that window before the older sleep resumes.
			now += 60_000
			const release = parked.shift()!
			const next = invoke('coupon-batch-drain', queued, sleep)
			release()
			await expect(active.result).resolves.toMatchObject({ state: 'paced' })
			active = next
		}
	}
	parked.shift()!()
	await expect(active.result).resolves.toMatchObject({ state: 'paced' })
	expect(queued).not.toHaveBeenCalled()
})

it('does not enqueue a continuation when the last step was paced', async () => {
	let i = 0
	fixture.runChunk.mockImplementation(async () =>
		i++ % 2 === 0 ? { state: 'worked' } : { state: 'paced', waitMs: 250 },
	)
	const { result, step } = invoke('coupon-batch-drain')
	await expect(result).resolves.toMatchObject({ state: 'paced' })
	expect(fixture.runChunk).toHaveBeenCalledTimes(40)
	expect(step.sleep).toHaveBeenCalledTimes(19)
	expect(step.sendEvent).not.toHaveBeenCalled()
})

it('both cron handlers exit before steps on an untouched deployment', async () => {
	delete process.env.AIH_COUPON_BATCH_SECRET
	delete process.env.AIH_COUPON_BATCH_ENABLED
	await expect(invoke('coupon-batch-drain').result).resolves.toEqual({
		state: 'disabled',
	})
	await expect(invoke('coupon-batch-alarms').result).resolves.toEqual({
		state: 'disabled',
	})
	expect(fixture.runChunk).not.toHaveBeenCalled()
	expect(fixture.drainAlerts).not.toHaveBeenCalled()
})

it('sends a stable dedupe key from the registered skip-singleton alarm while minting is off', async () => {
	expect(fixture.registrations.get('coupon-batch-alarms')).toMatchObject({
		singleton: { mode: 'skip' },
	})
	delete process.env.AIH_COUPON_BATCH_ENABLED
	vi.stubEnv('AIH_COUPON_BATCH_SECRET', 'f'.repeat(32))
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
