import { vi } from 'vitest'

import type {
	SessionAccess,
	SessionAccessCacheStore,
} from '../session-access-cache'

export function sessionAccessFixture(): SessionAccess {
	const role = {
		id: 'role-owner',
		organizationId: 'org-1',
		name: 'owner',
		description: null,
		active: true,
		createdAt: new Date('2025-01-02T03:04:05.678Z'),
		updatedAt: new Date('2025-01-02T03:04:05.678Z'),
		deletedAt: null,
	}
	return {
		roles: [
			{
				id: 'role-user',
				organizationId: null,
				name: 'user',
				description: 'default',
				active: true,
				createdAt: new Date('2024-05-06T07:08:09.010Z'),
				updatedAt: null,
				deletedAt: null,
			},
		],
		organizationRoles: [role],
		memberships: [
			{
				id: 'membership-1',
				organizationId: 'org-1',
				createdAt: new Date('2025-01-02T03:04:05.678Z'),
			},
		],
		discord: { expiresAt: 1_900_000_000 },
	}
}

/** In-memory Upstash stand-in that serializes like the REST client. */
export function createFakeStore(now: () => number = Date.now) {
	const data = new Map<string, { value: string; expiresAt: number | null }>()
	const live = (key: string) => {
		const entry = data.get(key)
		if (!entry) return null
		if (entry.expiresAt !== null && entry.expiresAt <= now()) {
			data.delete(key)
			return null
		}
		return entry
	}
	const store: SessionAccessCacheStore & { data: typeof data } = {
		data,
		mget: vi.fn(async (...keys: string[]) =>
			keys.map((key) => {
				const entry = live(key)
				return entry ? JSON.parse(entry.value) : null
			}),
		),
		set: vi.fn(async (key: string, value: unknown, { ex }: { ex: number }) => {
			data.set(key, {
				value: JSON.stringify(value),
				expiresAt: now() + ex * 1000,
			})
			return 'OK'
		}),
		del: vi.fn(async (...keys: string[]) => {
			for (const key of keys) data.delete(key)
			return keys.length
		}),
		incr: vi.fn(async (key: string) => {
			const entry = live(key)
			const next = (entry ? Number(JSON.parse(entry.value)) : 0) + 1
			data.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null })
			return next
		}),
		expire: vi.fn(async (key: string, seconds: number) => {
			const entry = live(key)
			if (!entry) return 0
			entry.expiresAt = now() + seconds * 1000
			return 1
		}),
	}
	return store
}
