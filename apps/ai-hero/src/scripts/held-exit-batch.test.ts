import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { createHeldRecoveryPorts } from '../../scripts/held-exit-recover-runtime'
import type { ScanCheckpoint } from '../../scripts/held-exit-kit-scan'
import {
	MAX_SCAN_AGE_MS,
	parseHeldRecoveryArgs,
	runHeldExitRecovery,
	runHeldRecoveryCommand,
} from '../../scripts/held-exit-recover'
import type {
	ContactRecord,
	SideEffectIntent,
} from '../lib/subscriber-marketing/types'

const start = '2026-10-06T12:00:00.000Z'
const contacts: ContactRecord[] = ['first', 'second', 'third'].map((id) => ({
	id,
	email: `${id}@example.test`,
	name: 'Fixture',
	lifecycle: 'new',
	isProvisional: false,
	createdAt: start,
	updatedAt: start,
}))
const row = (id: string): SideEffectIntent => ({
	id: `row-${id}`,
	contactId: id,
	nextActionId: 'fixture-action',
	provider: 'kit',
	type: 'subscribe-evergreen-list',
	status: 'held-for-exit',
	idempotencyKey: `contact:${id}:evergreen:list:shadow-newsletter`,
	createdAt: start,
	gates: [],
	reviewReasons: ['old-newsletter-exit-unconfirmed'],
	metadata: { list: 'shadow-newsletter' },
})
function ports() {
	let now = start
	let checkpoint: ScanCheckpoint | undefined
	const removeScan = vi.fn(async () => {
		checkpoint = undefined
	})
	const persist = vi.fn(async () => {
		throw new Error('Unexpected write')
	})
	const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
		async () =>
			new Response(
				JSON.stringify({
					subscribers: [{ id: 1 }],
					pagination: { has_next_page: false, total_count: 1 },
				}),
			),
	)
	const runtime = createHeldRecoveryPorts({
		repository: {
			findContactById: async (id) =>
				contacts.find((contact) => contact.id === id),
			createContactEvent: persist,
			findContactEventsByType: async () => [],
		},
		findRows: async (id) => [row(id)],
		findKitIdentities: async (id) =>
			id === 'third'
				? []
				: [
						{
							id: `identity-${id}`,
							contactId: id,
							externalId: id === 'first' ? '1' : '2',
						},
					],
		readOutbox: async () => [],
		withScanStore: async (_scope, action) =>
			action({
				load: async () => checkpoint,
				save: async (value) => {
					checkpoint = value
				},
				remove: removeScan,
			}),
		apiKey: 'fixture-key',
		eventKey: '',
		deploymentScope: 'fixture-scope',
		fetch: fetcher,
		now: () => now,
	})
	return {
		runtime,
		fetcher,
		persist,
		removeScan,
		setNow: (value: string) => {
			now = value
		},
	}
}

describe('shared recovery scan', () => {
	it('one scan serves present, absent and unproven identities without writes or identifiers', async () => {
		const { runtime, fetcher, persist } = ports()
		const close = vi.fn(async () => {})
		const result = await Effect.runPromise(
			runHeldRecoveryCommand(
				[
					'--contact-id',
					'first',
					'--contact-id',
					'second',
					'--drovr-contact-id',
					'third',
				],
				async () => ({ runtime, close }),
			),
		)
		expect(fetcher).toHaveBeenCalledOnce()
		expect(result.checks).toEqual({
			contactResolved: true,
			exactlyOneHeld: true,
			oldSequenceAbsent: false,
		})
		expect(result.results?.map((item) => [item.status, item.reason])).toEqual([
			['refused', 'old-sequence-member'],
			['planned', null],
			['refused', 'identity-unproven'],
		])
		expect(result.results?.[1]?.planHash).toMatch(/^[a-f0-9]{64}$/)
		expect(result.results?.[0]?.scans[0]?.fingerprint).toBe(
			result.results?.[1]?.scans[0]?.fingerprint,
		)
		expect(persist).not.toHaveBeenCalled()
		expect(close).toHaveBeenCalledOnce()
		for (const value of [
			'first',
			'second',
			'third',
			'fixture-key',
			'memberHashes',
			'end_cursor',
		])
			expect(JSON.stringify(result)).not.toContain(value)
	})
	it('AND-reduces batch checks when the first contact plans but a later identity refuses', async () => {
		const { runtime } = ports()
		const result = await Effect.runPromise(
			runHeldRecoveryCommand(
				['--contact-id', 'second', '--contact-id', 'third'],
				async () => ({ runtime, close: async () => {} }),
			),
		)
		expect(result.results?.[0]?.checks.oldSequenceAbsent).toBe(true)
		expect(result.results?.[1]?.checks.oldSequenceAbsent).toBe(false)
		expect(result.checks.oldSequenceAbsent).toBe(false)
	})
	it('does not memoize rejected scans', async () => {
		const { runtime, fetcher } = ports()
		fetcher.mockResolvedValueOnce(new Response('', { status: 404 }))
		await expect(runtime.scan('2')).rejects.toBeDefined()
		expect((await runtime.scan('2')).membership).toBe('absent')
		expect(fetcher).toHaveBeenCalledTimes(2)
	})
	it('clears the scope checkpoint and in-memory proof after requested recovery cleanup', async () => {
		const { runtime, fetcher, removeScan } = ports()
		await runtime.scan('2')
		await runtime.clearScan?.()
		expect(removeScan).toHaveBeenCalledOnce()
		await runtime.scan('2')
		expect(fetcher).toHaveBeenCalledTimes(2)
	})
	it('distinct absent contacts get distinct hashes bound to the shared scan; a new scan changes the hash', async () => {
		const { runtime, setNow, fetcher } = ports()
		const args = {
			mode: 'dry-run' as const,
			namespace: 'ai-hero' as const,
			contactId: 'second',
		}
		const first = await Effect.runPromise(runHeldExitRecovery(args, runtime))
		setNow(new Date(Date.parse(start) + MAX_SCAN_AGE_MS + 1).toISOString())
		const second = await Effect.runPromise(runHeldExitRecovery(args, runtime))
		expect(first.planHash).not.toBe(second.planHash)
		expect(fetcher).toHaveBeenCalledTimes(2)
		const other = {
			...runtime,
			findContactById: async () => contacts[2],
			inspect: async () => ({
				rows: [row('third')],
				identities: [
					{ id: 'identity-third', contactId: 'third', externalId: '3' },
				],
				history: [],
			}),
		}
		const third = await Effect.runPromise(
			runHeldExitRecovery({ ...args, contactId: 'third' }, other),
		)
		expect(third.planHash).not.toBe(second.planHash)
		expect(third.scans[0]?.fingerprint).toBe(second.scans[0]?.fingerprint)
	})
	it('rejects batch writes and batch readbacks before loading clients', async () => {
		const load = vi.fn()
		for (const mode of ['--write', '--readback']) {
			const result = await Effect.runPromise(
				runHeldRecoveryCommand(
					['--contact-id', 'first', '--drovr-contact-id', 'second', mode],
					load,
				),
			)
			expect(result).toMatchObject({
				status: 'refused',
				reason: 'arguments-invalid',
			})
			expect(result.prompt).toMatch(
				/^RecoveryRefused: you .* Accepted: .* Fix: .* Debug: /,
			)
		}
		expect(load).not.toHaveBeenCalled()
		expect(
			parseHeldRecoveryArgs([
				'--contact-id',
				'first',
				'--drovr-contact-id',
				'second',
			]).contacts,
		).toHaveLength(2)
	})
})
