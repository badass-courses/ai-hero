'use server'

import { revalidatePath } from 'next/cache'
import { FLAGS } from '@/flags'
import { getFlagKey } from '@/flags/flags-adapter'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'

export async function toggleFlag(key: string, value: boolean) {
	const { session, ability } = await getServerAuthSession()
	const userId = session?.user?.id

	await log.info('admin.flag.toggle', {
		flagKey: key,
		userId,
		value,
	})

	if (!session?.user) {
		await log.warn('admin.flag.unauthorized', {
			flagKey: key,
			userId,
			value,
		})
		throw new Error('Unauthorized')
	}

	if (!ability.can('manage', 'all')) {
		await log.warn('admin.flag.unauthorized', {
			flagKey: key,
			userId,
			value,
		})
		throw new Error('Unauthorized')
	}

	const flag = FLAGS[key as keyof typeof FLAGS]
	if (!flag) {
		await log.warn('admin.flag.invalid-key', {
			flagKey: key,
			userId,
			value,
		})
		throw new Error('Invalid flag key')
	}

	if (typeof value !== 'boolean') {
		await log.warn('admin.flag.toggle', {
			flagKey: key,
			userId,
			value,
			error: `Invalid value type: ${typeof value}`,
		})
		throw new Error('Value must be a boolean')
	}

	const redisKey = getFlagKey(key)
	let previousValue: string | null = null

	try {
		previousValue = await redis.get(redisKey)

		await log.debug('admin.flag.toggle', {
			flagKey: key,
			userId,
			value,
			previousValue,
		})

		await redis.set(redisKey, value.toString())

		revalidatePath('/admin/flags')

		await log.info('admin.flag.updated', {
			flagKey: key,
			userId,
			value,
			previousValue,
		})

		return value
	} catch (error) {
		await log.error('admin.flag.toggle', {
			flagKey: key,
			userId,
			value,
			previousValue,
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}
}
