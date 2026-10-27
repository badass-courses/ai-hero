import { mkdtemp, readFile, stat, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withScanFile } from '../../scripts/held-exit-scan-store'
import {
	membershipFromScan,
	readKitSequenceScan,
} from '../../scripts/held-exit-kit-scan'

const start = '2026-10-06T12:00:00.000Z'
describe('operator-owned private checkpoint', () => {
	it('persists and reuses a completed scan with stable fingerprints, exclusive ownership and private permissions', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'held-exit-fixture-'))
		const path = join(directory, 'scan.json')
		const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
			async () =>
				new Response(
					JSON.stringify({
						subscribers: [{ id: 1, email_address: 'private@example.test' }],
						pagination: { has_next_page: false, total_count: 1 },
					}),
				),
		)
		const options = { apiKey: 'fixture-key', now: () => start, fetch: fetcher }
		try {
			const first = await withScanFile(path, async (store) => {
				await expect(withScanFile(path, async () => {})).rejects.toMatchObject({
					reason: 'scan-locked',
				})
				return readKitSequenceScan({ ...options, store })
			})
			const second = await withScanFile(path, (store) =>
				readKitSequenceScan({ ...options, store }),
			)
			expect(fetcher).toHaveBeenCalledOnce()
			expect(
				membershipFromScan(first, '2', start, options.apiKey).fingerprint,
			).toBe(membershipFromScan(second, '2', start, options.apiKey).fingerprint)
			expect((await stat(path)).mode & 0o777).toBe(0o600)
			expect(await readFile(path, 'utf8')).not.toContain('private@example.test')
			expect(await readFile(path, 'utf8')).not.toContain('fixture-key')
			await expect(stat(`${path}.lock`)).rejects.toMatchObject({
				code: 'ENOENT',
			})
		} finally {
			await unlink(path)
			await rmdir(directory)
		}
	})
})
