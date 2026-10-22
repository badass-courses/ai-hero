import { z } from 'zod'

/**
 * Per-session cache for the role and membership part of the Auth.js session
 * callback. Entries are keyed by a SHA-256 of the session token, never the
 * token itself, and are stamped with a per-user generation. Any role or
 * membership write bumps the generation, so stale entries miss immediately.
 *
 * Every Redis failure or timeout falls through to the database read. The
 * cache can only skip a read; it never decides whether a session is valid.
 */

export const SESSION_ACCESS_CACHE_TTL_ENV = 'AUTH_SESSION_ACCESS_CACHE_TTL_SECONDS'
export const DEFAULT_SESSION_ACCESS_CACHE_TTL_SECONDS = 60
export const MAX_SESSION_ACCESS_CACHE_TTL_SECONDS = 3600
// Must stay well above the max entry TTL: an expired generation key reads as
// 0, and an entry written before the last bust must be gone by then.
const GENERATION_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_TIMEOUT_MS = 200
const ENTRY_VERSION = 1

export type SessionAccessRole = {
	id: string
	organizationId: string | null
	name: string
	description: string | null
	active: boolean
	createdAt: Date | null
	updatedAt: Date | null
	deletedAt: Date | null
}

export type SessionAccessMembership = {
	id: string
	organizationId: string | null
	createdAt: Date | null
}

/** Everything the session callback needs that depends only on the user. */
export type SessionAccess = {
	roles: SessionAccessRole[]
	organizationRoles: SessionAccessRole[]
	memberships: SessionAccessMembership[]
	/** Expiry only. Discord tokens never enter the cache. */
	discord: { expiresAt: number | null } | null
}

/** The subset of `@upstash/redis` this cache uses. */
export type SessionAccessCacheStore = {
	mget(...keys: string[]): Promise<unknown[]>
	set(key: string, value: unknown, options: { ex: number }): Promise<unknown>
	del(...keys: string[]): Promise<unknown>
	incr(key: string): Promise<number>
	expire(key: string, seconds: number): Promise<unknown>
}

export type SessionAccessCacheRead =
	| { status: 'hit'; access: SessionAccess }
	| { status: 'miss'; generation: number }
	| { status: 'bypass' }

export type SessionAccessCacheEvent =
	| 'read-failed'
	| 'write-failed'
	| 'bust-failed'
	| 'entry-invalid'

export type SessionAccessCache = {
	read(sessionToken: string, userId: string): Promise<SessionAccessCacheRead>
	write(
		sessionToken: string,
		userId: string,
		generation: number,
		access: SessionAccess,
	): Promise<void>
	bustUser(userId: string): Promise<void>
	bustSessionToken(sessionToken: string): Promise<void>
}

export function parseSessionAccessCacheTtl(raw: string | undefined) {
	if (raw === undefined || raw.trim() === '')
		return DEFAULT_SESSION_ACCESS_CACHE_TTL_SECONDS
	const value = Number(raw)
	if (!Number.isInteger(value) || value < 0)
		return DEFAULT_SESSION_ACCESS_CACHE_TTL_SECONDS
	return Math.min(value, MAX_SESSION_ACCESS_CACHE_TTL_SECONDS)
}

/** Users with no roles or memberships may be mid-provisioning; read them live. */
export function isSessionAccessCacheable(access: SessionAccess) {
	return access.roles.length > 0 && access.memberships.length > 0
}

async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

export async function sessionAccessEntryKey(sessionToken: string) {
	return `aih:session-access:v${ENTRY_VERSION}:${await sha256Hex(
		`session-access:${sessionToken}`,
	)}`
}

export function sessionAccessGenerationKey(userId: string) {
	return `aih:session-access-gen:v${ENTRY_VERSION}:${userId}`
}

const nullableDate = z
	.union([z.null(), z.string(), z.date()])
	.transform((value) => (value === null ? null : new Date(value)))
	.refine((date) => date === null || !Number.isNaN(date.getTime()))

const roleSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	active: z.boolean(),
	createdAt: nullableDate,
	updatedAt: nullableDate,
	deletedAt: nullableDate,
})

const entrySchema = z.object({
	v: z.literal(ENTRY_VERSION),
	userId: z.string(),
	generation: z.number().int(),
	access: z.object({
		roles: z.array(roleSchema),
		organizationRoles: z.array(roleSchema),
		memberships: z.array(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable(),
				createdAt: nullableDate,
			}),
		),
		discord: z.object({ expiresAt: z.number().nullable() }).nullable(),
	}),
})

function decode(value: unknown) {
	if (typeof value !== 'string') return value
	try {
		return JSON.parse(value)
	} catch {
		return undefined
	}
}

function toGeneration(value: unknown) {
	const decoded = typeof value === 'string' ? Number(value) : value
	return typeof decoded === 'number' && Number.isInteger(decoded) ? decoded : 0
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error('session access cache timed out')),
			timeoutMs,
		)
	})
	return Promise.race([operation, timeout]).finally(() => clearTimeout(timer))
}

export function createSessionAccessCache({
	getStore,
	ttlSeconds,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	onEvent = () => {},
}: {
	getStore: () => Promise<SessionAccessCacheStore | null>
	ttlSeconds: number
	timeoutMs?: number
	onEvent?: (event: SessionAccessCacheEvent, error?: unknown) => void
}): SessionAccessCache {
	const run = async <T>(
		operation: (store: SessionAccessCacheStore) => Promise<T>,
	) => {
		const store = await getStore()
		if (!store) return { ok: false as const, skipped: true as const }
		return {
			ok: true as const,
			value: await withTimeout(operation(store), timeoutMs),
		}
	}

	return {
		async read(sessionToken, userId) {
			if (ttlSeconds <= 0) return { status: 'bypass' }
			try {
				const entryKey = await sessionAccessEntryKey(sessionToken)
				const result = await run((store) =>
					store.mget(entryKey, sessionAccessGenerationKey(userId)),
				)
				if (!result.ok) return { status: 'bypass' }
				const [rawEntry, rawGeneration] = result.value
				const generation = toGeneration(rawGeneration)
				if (rawEntry === null || rawEntry === undefined)
					return { status: 'miss', generation }
				const entry = entrySchema.safeParse(decode(rawEntry))
				if (!entry.success) {
					onEvent('entry-invalid')
					return { status: 'miss', generation }
				}
				if (
					entry.data.userId !== userId ||
					entry.data.generation !== generation
				)
					return { status: 'miss', generation }
				return { status: 'hit', access: entry.data.access }
			} catch (error) {
				onEvent('read-failed', error)
				return { status: 'bypass' }
			}
		},

		async write(sessionToken, userId, generation, access) {
			if (ttlSeconds <= 0) return
			try {
				const entryKey = await sessionAccessEntryKey(sessionToken)
				await run((store) =>
					store.set(
						entryKey,
						{ v: ENTRY_VERSION, userId, generation, access },
						{ ex: ttlSeconds },
					),
				)
			} catch (error) {
				onEvent('write-failed', error)
			}
		},

		// Busts run even when reads are disabled, so turning the TTL back on
		// never revives an entry written before a role change.
		async bustUser(userId) {
			try {
				const key = sessionAccessGenerationKey(userId)
				await run(async (store) => {
					await store.incr(key)
					await store.expire(key, GENERATION_TTL_SECONDS)
				})
			} catch (error) {
				onEvent('bust-failed', error)
			}
		},

		async bustSessionToken(sessionToken) {
			try {
				const entryKey = await sessionAccessEntryKey(sessionToken)
				await run((store) => store.del(entryKey))
			} catch (error) {
				onEvent('bust-failed', error)
			}
		},
	}
}
