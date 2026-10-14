import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ScanStore } from './held-exit-kit-scan'
import { RecoveryRefused } from './held-exit-recover'

/** The invoking operator owns one private checkpoint and an exclusive scan lease.
 * Never reclaim another process's lock automatically. JSON checkpoints contain
 * cursors and hashed membership only, not provider bodies or credentials. */
export async function withScanFile<A>(
	path: string,
	action: (store: ScanStore) => Promise<A>,
): Promise<A> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const lockPath = `${path}.lock`
	const lock = await open(lockPath, 'wx', 0o600)
	try {
		return await action({
			load: async () => {
				try {
					return JSON.parse(await readFile(path, 'utf8')) as unknown
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT')
						return undefined
					throw new RecoveryRefused({ reason: 'provider-unavailable' })
				}
			},
			save: async (value) => {
				const temporary = `${path}.${randomUUID()}.tmp`
				const file = await open(temporary, 'wx', 0o600)
				try {
					try {
						await file.writeFile(JSON.stringify(value))
						await file.sync()
					} finally {
						await file.close()
					}
					await rename(temporary, path)
				} finally {
					await unlink(temporary).catch((error) => {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
					})
				}
			},
		})
	} finally {
		await lock.close()
		await unlink(lockPath)
	}
}
