import {
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ScanStore } from './held-exit-kit-scan'
import { MAX_SCAN_AGE_MS, RecoveryRefused } from './held-exit-recover'

const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === 'ENOENT'
const remove = async (path: string) => {
	try {
		await unlink(path)
	} catch (error) {
		if (!missing(error)) throw error
	}
}
async function secureDirectory(directory: string) {
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const info = await lstat(directory)
	if (
		info.isSymbolicLink() ||
		!info.isDirectory() ||
		info.uid !== process.getuid?.() ||
		(info.mode & 0o777) !== 0o700
	)
		throw new RecoveryRefused({ reason: 'scan-cache-unsafe' })
	for (const name of await readdir(directory)) {
		if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
		const path = join(directory, name),
			file = await lstat(path).catch((error) => {
				if (!missing(error)) throw error
				return undefined
			})
		if (file?.isSymbolicLink())
			throw new RecoveryRefused({ reason: 'scan-cache-unsafe' })
		if (file?.isFile() && Date.now() - file.mtimeMs > MAX_SCAN_AGE_MS)
			await remove(path)
	}
}

/** The recovery operator owns one private checkpoint and an exclusive lease.
 * Identifier-bearing cursors remain private; HMACs authenticate proof, not access.
 * Never reclaim another process's lock automatically. */
export async function withScanFile<A>(
	path: string,
	action: (store: ScanStore) => Promise<A>,
): Promise<A> {
	const directory = dirname(path)
	await secureDirectory(directory)
	const lockPath = `${path}.lock`
	const lock = await open(lockPath, 'wx', 0o600).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST')
			throw new RecoveryRefused({ reason: 'scan-locked' })
		throw error
	})
	let failed = false
	try {
		await lock.writeFile(
			JSON.stringify({
				pid: process.pid,
				hostname: hostname(),
				startedAt: new Date().toISOString(),
			}),
		)
		await lock.sync()
		return await action({
			load: async () => {
				try {
					const file = await lstat(path)
					if (
						!file.isFile() ||
						file.isSymbolicLink() ||
						file.uid !== process.getuid?.() ||
						(file.mode & 0o777) !== 0o600
					)
						throw new RecoveryRefused({ reason: 'scan-cache-unsafe' })
					if (Date.now() - file.mtimeMs > MAX_SCAN_AGE_MS) {
						await remove(path)
						return undefined
					}
					return JSON.parse(await readFile(path, 'utf8')) as unknown
				} catch (error) {
					if (missing(error)) return undefined
					throw error
				}
			},
			remove: () => remove(path),
			save: async (value) => {
				const temporary = `${path}.${randomUUID()}.tmp`
				let primaryFailure = false
				try {
					const file = await open(temporary, 'wx', 0o600)
					try {
						await file.writeFile(JSON.stringify(value))
						await file.sync()
					} finally {
						await file.close()
					}
					await rename(temporary, path)
					const dir = await open(directory, 'r')
					try {
						await dir.sync()
					} finally {
						await dir.close()
					}
				} catch (error) {
					primaryFailure = true
					throw error
				} finally {
					await remove(temporary).catch((error) => {
						if (!primaryFailure) throw error
					})
				}
			},
		})
	} catch (error) {
		failed = true
		throw error
	} finally {
		// A cleanup failure must never replace the transport/database's primary refusal.
		let cleanupError: unknown
		try {
			await lock.close()
		} catch (error) {
			cleanupError = error
		}
		try {
			await remove(lockPath)
		} catch (error) {
			cleanupError ??= error
		}
		if (!failed && cleanupError) throw cleanupError
	}
}
