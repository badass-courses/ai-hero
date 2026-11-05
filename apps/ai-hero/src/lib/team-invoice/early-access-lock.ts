import { randomUUID } from 'node:crypto'

export type EarlyAccessRedis = {
	set(
		key: string,
		token: string,
		options: { nx: true; px: number },
	): Promise<unknown>
	eval(script: string, keys: string[], args: string[]): Promise<unknown>
}

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then
	return redis.call('del', KEYS[1])
else return 0 end`

/** Shared by apply-grant, apply-revoke and payment reconciliation. A crashed
 * holder expires after 60s. Release must never remove a successor's lease.
 * This bounded lease is not a fence against a worker paused beyond its TTL. */
export function createEarlyAccessLock(redis: EarlyAccessRedis) {
	return async function lock<T>(
		id: string,
		work: () => Promise<T>,
	): Promise<T> {
		const key = `aih:early-access:lock:${id}`
		const token = randomUUID()
		if ((await redis.set(key, token, { nx: true, px: 60_000 })) !== 'OK')
			throw new Error(
				'Another early-access operation holds this invoice; retry after its readback',
			)
		try {
			return await work()
		} finally {
			if ((await redis.eval(RELEASE, [key], [token])) !== 1)
				throw new Error(
					'Early-access lease expired or changed; verify invoice before retrying',
				)
		}
	}
}
