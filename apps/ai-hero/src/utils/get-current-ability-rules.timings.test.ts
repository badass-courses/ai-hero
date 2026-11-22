import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { log } from '@/server/logger'
import { sampleTimings } from '@/server/perf'

import {
	getAbilityForResource,
	type AbilityTimingPart,
} from './get-current-ability-rules'

// Use React's real server cache, with a fresh renderer cache for each test.
const serverReact = await vi.hoisted(async () => {
	const { createRequire } = await import('node:module')
	const { dirname, join } = await import('node:path')
	const require = createRequire(import.meta.url)
	return require(
		join(dirname(require.resolve('react/package.json')), 'react.react-server.js'),
	) as {
		cache: typeof import('react').cache
		__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
			A: { getCacheForType<T>(create: () => T): T } | null
		}
	}
})
vi.mock('react', async (original) => ({
	...(await original<typeof import('react')>()),
	cache: serverReact.cache,
}))

const mocks = vi.hoisted(() => ({
	session: vi.fn(async () => ({ session: { user: { id: 'user' } } })),
	workshop: vi.fn(async () => ({ id: 'workshop' })),
	cachedLesson: vi.fn(async () => ({ id: 'lesson' })),
	minimalWorkshop: vi.fn(async () => ({ id: 'workshop' })),
	lesson: vi.fn(async () => ({ id: 'lesson' })),
	entitlementTypes: vi.fn(async () => []),
	section: vi.fn(async () => null),
	purchases: vi.fn(async () => []),
	entitlements: vi.fn(async () => []),
	rules: vi.fn(() => []),
	ability: vi.fn(() => ({ can: () => false })),
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/ability', () => ({
	defineRulesForPurchases: mocks.rules,
	createAppAbility: mocks.ability,
}))
vi.mock('@/db', () => ({
	db: { query: { entitlementTypes: { findMany: mocks.entitlementTypes } } },
	courseBuilderAdapter: { getPurchasesForUser: mocks.purchases },
}))
vi.mock('@/lib/entitlements-query', () => ({ getAllUserEntitlements: mocks.entitlements }))
vi.mock('@/lib/lessons-query', () => ({ getCachedLesson: mocks.cachedLesson, getLesson: mocks.lesson }))
vi.mock('@/lib/workshops-query', () => ({ getWorkshopAccessTree: mocks.workshop, getCachedMinimalWorkshop: mocks.minimalWorkshop }))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.session }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(async () => {}), error: vi.fn(async () => {}) },
	serializeError: vi.fn(),
}))
vi.mock('./get-resource-section', () => ({ getResourceSection: mocks.section }))
vi.mock('./get-workshop-resource-ids', () => ({ getWorkshopResourceIds: () => [] }))

const internals = serverReact.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

function newRenderCache() {
	const entries = new Map<unknown, unknown>()
	internals.A = {
		getCacheForType<T>(create: () => T) {
			if (!entries.has(create)) entries.set(create, create())
			return entries.get(create) as T
		},
	}
}

describe('ability sub-timings', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		newRenderCache()
	})

	afterEach(() => {
		internals.A = null
	})

	it('records a cold sample and shares one resolution across distinct timings objects', async () => {
		const first = sampleTimings<AbilityTimingPart>('perf.first', 1)
		const second = sampleTimings<AbilityTimingPart>('perf.second', 1)

		const [initial, cached] = await Promise.all([
			getAbilityForResource('lesson', 'workshop', first),
			getAbilityForResource('lesson', 'workshop', second),
		])
		expect(cached).toBe(initial)
		for (const lookup of Object.values(mocks)) expect(lookup).toHaveBeenCalledOnce()

		const ms = expect.any(Number)
		first.finish({}, [])
		second.finish({}, [])
		expect(log.info).toHaveBeenCalledWith('perf.first', {
			abilityWave1: ms,
			abilityWorkshop: ms,
			abilityWave2: ms,
			abilityPurchases: ms,
			abilityEntitlements: ms,
			abilityRules: ms,
			abilityWrapperExtras: ms,
		})
		expect(log.info).toHaveBeenCalledWith('perf.second', {})

		newRenderCache()
		expect(await getAbilityForResource('lesson', 'workshop')).not.toBe(initial)
		expect(mocks.ability).toHaveBeenCalledTimes(2)
	})

	it('keeps a result warmed by an uninstrumented caller', async () => {
		const initial = await getAbilityForResource('lesson', 'workshop')
		const timings = sampleTimings<AbilityTimingPart>('perf.test', 1)
		expect(await getAbilityForResource('lesson', 'workshop', timings)).toBe(initial)
		for (const lookup of Object.values(mocks)) expect(lookup).toHaveBeenCalledOnce()
	})

	it('preserves the access result when starting or stopping a timer throws', async () => {
		const timings = {
			...sampleTimings<AbilityTimingPart>('perf.test', 1),
			start(part: AbilityTimingPart) {
				if (part === 'abilityWorkshop') throw new Error('start failed')
				return () => {
				throw new Error('stop failed')
			}
			},
		}
		const result = await getAbilityForResource('lesson', 'workshop', timings)
		expect(result.canViewLesson).toBe(false)
		for (const lookup of Object.values(mocks)) expect(lookup).toHaveBeenCalledOnce()
	})

	it('preserves a lookup rejection even if stopping its timer throws', async () => {
		const failure = new Error('lookup failed')
		mocks.purchases.mockRejectedValueOnce(failure)
		const timings = {
			...sampleTimings<AbilityTimingPart>('perf.test', 1),
			start: () => () => {
				throw new Error('stop failed')
			},
		}

		await expect(getAbilityForResource('lesson', 'workshop', timings)).rejects.toBe(failure)
		expect(mocks.purchases).toHaveBeenCalledOnce()
		expect(mocks.rules).not.toHaveBeenCalled()
	})
})
