import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { Effect } from 'effect'
import {
	readKitExitMembership,
	readKitSequenceScan,
	membershipFromScan,
	type ScanCheckpoint,
} from '../../scripts/held-exit-kit-scan'
import { MAX_SCAN_AGE_MS } from '../../scripts/held-exit-recover'

const start = '2026-10-06T12:00:00.000Z'
const page = (ids: number[], next?: string) =>
	new Response(
		JSON.stringify({
			subscribers: ids.map((id) => ({ id })),
			pagination: { has_next_page: Boolean(next), end_cursor: next ?? null },
		}),
	)
const base = {
	apiKey: 'fixture-key',
	now: () => start,
	sleep: async () => {},
	random: () => 0,
}

describe('resumable GET-only membership scan', () => {
	it('retries 502 at the same cursor, honors Retry-After, then completes', async () => {
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(page([1], 'next'))
			.mockResolvedValueOnce(
				new Response('', { status: 502, headers: { 'Retry-After': '2' } }),
			)
			.mockResolvedValueOnce(page([2]))
		const sleep = vi.fn(async () => {})
		const scan = await readKitSequenceScan({ ...base, fetch: fetcher, sleep })
		expect(membershipFromScan(scan, '3', start)).toMatchObject({
			membership: 'absent',
			complete: true,
			pages: 2,
		})
		expect(
			fetcher.mock.calls.map(([url]) =>
				new URL(String(url)).searchParams.get('after'),
			),
		).toEqual([null, 'next', 'next'])
		expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
			true,
		)
		expect(sleep).toHaveBeenCalledWith(2000, undefined)
	})
	it('honors date Retry-After and refuses a delay above the named backoff cap', async () => {
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(
				new Response('', {
					status: 429,
					headers: {
						'Retry-After': new Date(Date.parse(start) + 3000).toUTCString(),
					},
				}),
			)
			.mockResolvedValueOnce(page([]))
		const sleep = vi.fn(async () => {})
		await readKitSequenceScan({ ...base, fetch: fetcher, sleep })
		expect(sleep).toHaveBeenCalledWith(3000, undefined)
		const slow = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(
				new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
			)
		await expect(
			readKitSequenceScan({ ...base, fetch: slow }),
		).rejects.toBeDefined()
		expect(slow).toHaveBeenCalledOnce()
	})
	it('caps retries at five attempts and never retries 404 or malformed JSON', async () => {
		for (const status of [502, 429, 404]) {
			let calls = 0
			const fetcher = vi
				.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
				.mockImplementation(async () =>
					++calls > 5 ? page([]) : new Response('', { status }),
				)
			await expect(
				readKitSequenceScan({ ...base, fetch: fetcher }),
			).rejects.toBeDefined()
			expect(fetcher).toHaveBeenCalledTimes(status === 404 ? 1 : 5)
		}
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockImplementation(async () => new Response('{'))
		await expect(
			readKitSequenceScan({ ...base, fetch: fetcher }),
		).rejects.toBeDefined()
		expect(fetcher).toHaveBeenCalledTimes(1)
	})
	it('retries a timeout, but not an arbitrary transport error', async () => {
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockRejectedValueOnce(new DOMException('fixture', 'TimeoutError'))
			.mockResolvedValueOnce(page([]))
		expect(
			(await readKitSequenceScan({ ...base, fetch: fetcher })).complete,
		).toBe(true)
		expect(fetcher).toHaveBeenCalledTimes(2)
		const bad = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockRejectedValue(new Error('fixture'))
		await expect(
			readKitSequenceScan({ ...base, fetch: bad }),
		).rejects.toBeDefined()
		expect(bad).toHaveBeenCalledTimes(1)
	})
	it('resumes a persisted partial scan without replaying a parsed page', async () => {
		let saved: ScanCheckpoint | undefined
		const store = {
			load: async () => saved,
			save: async (value: ScanCheckpoint) => {
				saved = structuredClone(value)
			},
		}
		const first = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(page([1], 'next'))
			.mockImplementation(async () => new Response('', { status: 502 }))
		await expect(
			readKitSequenceScan({ ...base, fetch: first, store }),
		).rejects.toBeDefined()
		expect(saved?.complete).toBe(false)
		expect(membershipFromScan(saved!, '3', start).membership).toBe('unknown')
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(page([2]))
		const scan = await readKitSequenceScan({ ...base, fetch: fetcher, store })
		expect(
			new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('after'),
		).toBe('next')
		expect(scan.pages).toBe(2)
		expect(membershipFromScan(scan, '1', start).membership).toBe('present')
		expect(membershipFromScan(scan, '3', start).membership).toBe('absent')
	})
	it('freshness is inclusive at the bound, invalid outside it, and restarts stale checkpoints', async () => {
		const scan = await readKitSequenceScan({
			...base,
			fetch: async () => page([]),
		})
		const at = (offset: number) =>
			new Date(Date.parse(start) + offset).toISOString()
		expect(
			membershipFromScan(scan, '3', at(MAX_SCAN_AGE_MS - 1)).membership,
		).toBe('absent')
		expect(membershipFromScan(scan, '3', at(MAX_SCAN_AGE_MS)).membership).toBe(
			'absent',
		)
		expect(
			membershipFromScan(scan, '3', at(MAX_SCAN_AGE_MS + 1)).membership,
		).toBe('unknown')
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(page([]))
		const restarted = await readKitSequenceScan({
			...base,
			now: () => at(MAX_SCAN_AGE_MS + 1),
			fetch: fetcher,
			store: { load: async () => scan, save: async () => {} },
		})
		expect(restarted.startedAt).toBe(at(MAX_SCAN_AGE_MS + 1))
		expect(fetcher).toHaveBeenCalledOnce()
	})
	it('transient schedules under the cap preserve clean membership; partial scans never prove absence', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.array(fc.constantFrom(502, 503, 429, 'timeout' as const), {
						maxLength: 4,
					}),
					{
						minLength: 1,
						maxLength: 8,
					},
				),
				async (failures) => {
					let index = 0,
						attempt = 0
					const fetcher: typeof fetch = async () => {
						if (attempt < failures[index]!.length) {
							const failure = failures[index]![attempt++]!
							if (failure === 'timeout')
								throw new DOMException('fixture', 'TimeoutError')
							return new Response('', { status: failure })
						}
						const result = page(
							[index + 1],
							index < failures.length - 1 ? `cursor-${index + 1}` : undefined,
						)
						index++
						attempt = 0
						return result
					}
					const scan = await readKitSequenceScan({ ...base, fetch: fetcher })
					let cleanIndex = 0
					const clean = await readKitSequenceScan({
						...base,
						fetch: async () => {
							const result = page(
								[cleanIndex + 1],
								cleanIndex < failures.length - 1
									? `cursor-${cleanIndex + 1}`
									: undefined,
							)
							cleanIndex++
							return result
						},
					})
					const partial = {
						...scan,
						complete: false,
						cursor: 'pending',
						cursors: [...scan.cursors, 'pending'],
					}
					for (const id of ['1', String(failures.length + 1)]) {
						expect(membershipFromScan(scan, id, start)).toEqual(
							membershipFromScan(clean, id, start),
						)
						expect(membershipFromScan(scan, id, start).membership).toBe(
							id === '1' ? 'present' : 'absent',
						)
						expect(membershipFromScan(partial, id, start).membership).toBe(
							'unknown',
						)
						expect(
							membershipFromScan(
								scan,
								id,
								new Date(Date.parse(start) + MAX_SCAN_AGE_MS + 1).toISOString(),
							).membership,
						).toBe('unknown')
					}
				},
			),
			{ numRuns: 40 },
		)
	})
	it('never retries a parsed page when checkpoint persistence fails, even with a timeout-shaped error', async () => {
		const fetcher = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValueOnce(page([]))
		await expect(
			readKitSequenceScan({
				...base,
				fetch: fetcher,
				store: {
					load: async () => undefined,
					save: async () => {
						throw new DOMException('fixture', 'TimeoutError')
					},
				},
			}),
		).rejects.toBeDefined()
		expect(fetcher).toHaveBeenCalledOnce()
	})
	it('keeps the public wrapper private and refuses expired or partial evidence', async () => {
		const result = await Effect.runPromise(
			readKitExitMembership({
				...base,
				subscriberId: '3',
				fetch: async () => page([1]),
			}),
		)
		expect(result.membership).toBe('absent')
		expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
		expect(JSON.stringify(result)).not.toContain('memberHashes')
	})
})
