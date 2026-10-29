import {
	mkdtemp,
	readFile,
	stat,
	unlink,
	rmdir,
	chmod,
	utimes,
	writeFile,
	symlink,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import {
	readKitSequenceScan,
	membershipFromScan,
} from '../../scripts/held-exit-kit-scan'
import { withScanFile } from '../../scripts/held-exit-scan-store'
import {
	runHeldExitRecovery,
	MAX_PROOF_AGE_AT_WRITE_MS,
	MAX_SCAN_AGE_MS,
	type RecoveryRuntime,
} from '../../scripts/held-exit-recover'

const start = '2026-10-06T12:00:00.000Z'
const base = {
	apiKey: 'fixture-key',
	now: () => start,
	sleep: async () => {},
	random: () => 0,
}
const page = (ids: number[], total: number, next?: string) =>
	new Response(
		JSON.stringify({
			subscribers: ids.map((id) => ({ id })),
			pagination: {
				total_count: total,
				has_next_page: Boolean(next),
				end_cursor: next ?? null,
			},
		}),
	)

describe('review security and proof contracts', () => {
	it('requires the first-page total and refuses a short final page', async () => {
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(page([1], 3, 'next'))
			.mockResolvedValueOnce(page([2], 3))
		const scan = await readKitSequenceScan({ ...base, fetch: fetcher })
		expect(scan.complete).toBe(false)
		const missingTotal = await readKitSequenceScan({
			...base,
			fetch: async () =>
				new Response(
					JSON.stringify({
						subscribers: [],
						pagination: { has_next_page: false },
					}),
				),
		})
		expect(
			membershipFromScan(missingTotal, '4', start, base.apiKey).membership,
		).toBe('unknown')
		expect(membershipFromScan(scan, '4', start, base.apiKey).membership).toBe(
			'unknown',
		)
		expect(
			new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get(
				'include_total_count',
			),
		).toBe('true')
		expect(
			new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.has(
				'include_total_count',
			),
		).toBe(false)
	})
	it('ignores a valid different-scope checkpoint but refuses a tampered same-scope checkpoint', async () => {
		const original = await readKitSequenceScan({
			...base,
			scope: 'old-scope',
			fetch: async () => page([1], 1),
		})
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(page([], 0))
		let saved: typeof original | undefined
		const changed = await readKitSequenceScan({
			...base,
			scope: 'new-scope',
			fetch: fetcher,
			store: {
				load: async () => original,
				save: async (value) => {
					saved = value
				},
			},
		})
		expect(fetcher).toHaveBeenCalledOnce()
		expect(saved?.scope).toBe(changed.scope)
		expect(saved?.scope).not.toBe(original.scope)
		const tampered = {
			...changed,
			memberHashes: original.memberHashes,
			subscribers: 1,
			expectedTotal: 1,
		}
		await expect(
			readKitSequenceScan({
				...base,
				scope: 'new-scope',
				fetch: fetcher,
				store: { load: async () => tampered, save: async () => {} },
			}),
		).rejects.toBeDefined()
		expect(
			membershipFromScan(tampered, '4', start, base.apiKey).membership,
		).toBe('unknown')
	})
	it('membership hashes are keyed rather than reversible digests of small integers', async () => {
		const scan = await readKitSequenceScan({
			...base,
			fetch: async () => page([1], 1),
		})
		expect(scan.memberHashes[0]).not.toBe(
			createHash('sha256').update('1').digest('hex'),
		)
		expect(
			membershipFromScan(scan, '1', start, 'different-fixture-key').membership,
		).toBe('unknown')
	})
	it('freshness is checked before every sleep and subsequent attempt', async () => {
		for (const phase of ['before-sleep', 'after-sleep']) {
			let now = start
			const expired = new Date(
				Date.parse(start) + MAX_SCAN_AGE_MS + 1,
			).toISOString()
			const sleep = vi.fn(async () => {
				now = expired
			})
			const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
				async () => {
					if (phase === 'before-sleep') now = expired
					return new Response('', { status: 502 })
				},
			)
			await expect(
				readKitSequenceScan({ ...base, fetch: fetcher, now: () => now, sleep }),
			).rejects.toBeDefined()
			expect(fetcher).toHaveBeenCalledOnce()
			expect(sleep).toHaveBeenCalledTimes(phase === 'before-sleep' ? 0 : 1)
		}
	})
	it('an unlink failure never masks the primary action error', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'held-exit-cleanup-'))
		const path = join(directory, 'scope.json')
		try {
			await expect(
				withScanFile(path, async () => {
					await chmod(directory, 0o500)
					throw new Error('fixture-primary')
				}),
			).rejects.toThrow('fixture-primary')
			if (process.getuid?.() !== 0)
				await expect(stat(`${path}.lock`)).resolves.toBeDefined()
		} finally {
			await chmod(directory, 0o700)
			await unlink(`${path}.lock`).catch(() => {})
			await rmdir(directory)
		}
	})
	it('a definitive 404 racing an expired timeout never retries', async () => {
		const deadline = new AbortController()
		const timeout = vi
			.spyOn(AbortSignal, 'timeout')
			.mockReturnValue(deadline.signal)
		const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
			async () => {
				deadline.abort(new DOMException('fixture', 'TimeoutError'))
				return new Response('', { status: 404 })
			},
		)
		try {
			await expect(
				readKitSequenceScan({ ...base, fetch: fetcher }),
			).rejects.toBeDefined()
			expect(fetcher).toHaveBeenCalledOnce()
		} finally {
			timeout.mockRestore()
		}
	})
	it('a syntax error after timeout abort never retries', async () => {
		const deadline = new AbortController()
		const timeout = vi
			.spyOn(AbortSignal, 'timeout')
			.mockReturnValue(deadline.signal)
		const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
			async () => {
				const response = new Response('{')
				deadline.abort(new DOMException('fixture', 'TimeoutError'))
				return response
			},
		)
		try {
			await expect(
				readKitSequenceScan({ ...base, fetch: fetcher }),
			).rejects.toBeDefined()
			expect(fetcher).toHaveBeenCalledOnce()
		} finally {
			timeout.mockRestore()
		}
	})
	it('write proof older than the named completion-age bound refuses with zero persists', async () => {
		const scan = membershipFromScan(
			await readKitSequenceScan({ ...base, fetch: async () => page([], 0) }),
			'1',
			start,
			base.apiKey,
		)
		const persist = vi.fn(async () => {
			throw new Error('Unexpected write')
		})
		const now = new Date(
			Date.parse(start) + MAX_PROOF_AGE_AT_WRITE_MS + 1,
		).toISOString()
		const runtime: RecoveryRuntime = {
			approvalScope: 'fixture-scope',
			now: () => start,
			findContactById: async () => ({
				id: 'fixture',
				email: 'fixture@example.test',
				name: 'Fixture',
				lifecycle: 'new',
				isProvisional: false,
				createdAt: start,
				updatedAt: start,
			}),
			inspect: async () => ({
				rows: [
					{
						id: 'row',
						contactId: 'fixture',
						nextActionId: 'action',
						type: 'subscribe-evergreen-list',
						provider: 'kit',
						status: 'held-for-exit',
						idempotencyKey: 'contact:fixture:evergreen:list:shadow-newsletter',
						createdAt: start,
						gates: [],
						reviewReasons: ['old-newsletter-exit-unconfirmed'],
						metadata: { list: 'shadow-newsletter' },
					},
				],
				identities: [{ id: 'identity', contactId: 'fixture', externalId: '1' }],
				history: [],
			}),
			scan: async () => scan,
			persist,
			notify: vi.fn(async () => 1),
			currentMembership: async () => 'exited',
			readback: async () => ({ eventDerivable: false, outbox: [] }),
		}
		const plan = await Effect.runPromise(
			runHeldExitRecovery(
				{ namespace: 'ai-hero', contactId: 'fixture', mode: 'dry-run' },
				runtime,
			),
		)
		expect(plan.status).toBe('planned')
		runtime.now = () => now
		const result = await Effect.runPromise(
			runHeldExitRecovery(
				{
					namespace: 'ai-hero',
					contactId: 'fixture',
					mode: 'write',
					approval: 'fixture-approval',
					planHash: plan.planHash!,
				},
				runtime,
			),
		)
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'proof-expired',
		})
		expect(persist).not.toHaveBeenCalled()
	})
	it('secures the directory, records lock ownership, prunes stale data, and maps a competing lease', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'held-exit-review-'))
		const path = join(directory, 'scope.json'),
			stale = join(directory, 'old.json'),
			temporary = join(directory, 'old.tmp')
		try {
			for (const file of [stale, temporary]) {
				await writeFile(file, '{}')
				await utimes(file, 0, 0)
			}
			await withScanFile(path, async () => {
				const metadata = JSON.parse(await readFile(`${path}.lock`, 'utf8'))
				expect(metadata).toMatchObject({
					pid: process.pid,
					hostname: expect.any(String),
					startedAt: expect.any(String),
				})
				await expect(withScanFile(path, async () => {})).rejects.toMatchObject({
					reason: 'scan-locked',
				})
				await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
				await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
			})
			await chmod(directory, 0o755)
			await expect(withScanFile(path, async () => {})).rejects.toMatchObject({
				reason: 'scan-cache-unsafe',
			})
			await chmod(directory, 0o700)
			const link = `${directory}-link`
			await symlink(directory, link)
			try {
				await expect(
					withScanFile(join(link, 'scope.json'), async () => {}),
				).rejects.toMatchObject({ reason: 'scan-cache-unsafe' })
			} finally {
				await unlink(link)
			}
		} finally {
			for (const file of [stale, temporary, `${path}.lock`])
				await unlink(file).catch(() => {})
			await rmdir(directory)
		}
	})
})
