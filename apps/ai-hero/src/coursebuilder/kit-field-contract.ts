import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'

/**
 * Course Builder's Kit field contract (create missing custom fields, write
 * them, read the subscriber back) with the field check done once per
 * instance instead of once per field per send.
 *
 * Course Builder checks each requested field by reading the whole subscriber
 * and its tags, then subscribes, reads again, writes, and reads again. On a
 * fresh instance that is two extra Kit reads per personalization field: up to
 * 32 sequential calls for one value-path send, and any one of them stalling
 * held drovr's 15 s request open (2026-09-25).
 *
 * Here one `GET /v3/custom_fields` fills a per-instance cache of field keys
 * for KIT_CUSTOM_FIELD_CACHE_TTL_MS; only keys Kit does not have are created.
 * A warm send is four calls: subscribe, write the fields, read the
 * subscriber, read its tags. The cache can go stale (a field deleted in Kit),
 * so a 4xx on the field write, or a requested field missing from the
 * readback, invalidates it, re-ensures the fields, and writes once more.
 */

export const KIT_CUSTOM_FIELD_CACHE_TTL_MS = 10 * 60_000

/**
 * Kit still lacks requested fields after the one recheck. Callers treat a
 * returned subscriber's requested fields as confirmed, so the contract fails
 * instead. Carries field keys only, never values.
 */
export class KitFieldsUnconfirmedError extends Error {
	readonly missing: string[]

	constructor(missing: string[]) {
		super(`Kit did not keep custom fields: ${missing.join(', ')}`)
		this.name = 'KitFieldsUnconfirmedError'
		this.missing = missing
	}
}

const KIT_V3 = 'https://api.convertkit.com/v3'

export type KitCustomFieldCache = {
	/** Known field keys, or undefined when the cache is empty or expired. */
	known(): ReadonlySet<string> | undefined
	remember(keys: Iterable<string>, listed: boolean): void
	invalidate(): void
}

export function createKitCustomFieldCache(
	options: { ttlMs?: number; now?: () => number } = {},
): KitCustomFieldCache {
	const ttlMs = options.ttlMs ?? KIT_CUSTOM_FIELD_CACHE_TTL_MS
	const now = options.now ?? Date.now
	let keys: Set<string> | undefined
	let listedAt = 0
	return {
		known() {
			if (!keys || now() - listedAt > ttlMs) return undefined
			return keys
		},
		remember(added, listed) {
			if (listed) {
				keys = new Set(added)
				listedAt = now()
				return
			}
			if (!keys) return
			for (const key of added) keys.add(key)
		},
		invalidate() {
			keys = undefined
			listedAt = 0
		},
	}
}

export type KitFieldSubscribeOptions = {
	listId?: string | number
	listType?: string
	user: { email: string; name?: string | null }
	fields?: Record<string, unknown>
}

export type KitFieldContractDeps = {
	apiKey: string | undefined
	apiSecret: string | undefined
	cache: KitCustomFieldCache
	fetch?: typeof globalThis.fetch
}

/** Subscribe, write fields, read back. Kit refusals throw ConvertKitApiError. */
export async function subscribeWithKitFields(
	options: KitFieldSubscribeOptions,
	deps: KitFieldContractDeps,
): Promise<Record<string, unknown> | undefined> {
	// Refuse a bad target before any Kit call, as Course Builder does.
	const subscribePath = `/${endpointFor(options.listType)}/${requiredListId(options.listId)}/subscribe`
	const kit = kitClient(deps)
	const fields = options.fields ?? {}
	const keys = Object.keys(fields)

	if (keys.length > 0) await ensureCustomFields(keys, kit, deps.cache)
	const subscribed = await kit.post<{
		subscription?: { subscriber?: { id?: number | string } }
	}>(subscribePath, {
		api_key: deps.apiKey,
		email: options.user.email,
		first_name: options.user.name ?? undefined,
		...(keys.length > 0 ? { fields } : {}),
	})
	const subscriberId = subscribed?.subscription?.subscriber?.id
	if (subscriberId === undefined || subscriberId === null) {
		throw new Error(
			`Unexpected ConvertKit response structure: ${JSON.stringify(subscribed)}`,
		)
	}
	if (keys.length === 0) return await readSubscriber(kit, subscriberId)

	const write = () =>
		kit.put(`/subscribers/${subscriberId}`, {
			api_secret: deps.apiSecret,
			fields,
		})
	try {
		await write()
	} catch (error) {
		if (!isFieldRefusal(error)) throw error
		return await recheckAndWrite(keys, kit, deps.cache, write, subscriberId)
	}

	const readback = await readSubscriber(kit, subscriberId)
	if (!readback || missingKeys(readback, keys).length === 0) return readback
	// The cache said these fields exist; Kit did not keep them. Recheck once.
	return await recheckAndWrite(keys, kit, deps.cache, write, subscriberId)
}

/** The one recheck: forget the cache, ensure the fields, write, and confirm. */
async function recheckAndWrite(
	keys: readonly string[],
	kit: KitClient,
	cache: KitCustomFieldCache,
	write: () => Promise<unknown>,
	subscriberId: number | string,
): Promise<Record<string, unknown> | undefined> {
	cache.invalidate()
	await ensureCustomFields(keys, kit, cache)
	await write()
	const readback = await readSubscriber(kit, subscriberId)
	if (!readback) return readback
	const missing = missingKeys(readback, keys)
	if (missing.length > 0) throw new KitFieldsUnconfirmedError(missing)
	return readback
}

async function ensureCustomFields(
	keys: readonly string[],
	kit: KitClient,
	cache: KitCustomFieldCache,
): Promise<void> {
	const cached = cache.known()
	if (cached && keys.every((key) => cached.has(key))) return
	const listed = await kit.get<{ custom_fields?: { key?: string }[] }>(
		'/custom_fields',
		'key',
	)
	const existing = new Set(
		(listed?.custom_fields ?? [])
			.map((field) => field.key)
			.filter((key): key is string => typeof key === 'string'),
	)
	cache.remember(existing, true)
	for (const key of keys) {
		if (existing.has(key)) continue
		// Kit derives the key from the label; ours are already snake_case keys.
		await kit.post('/custom_fields', { api_secret: kit.apiSecret, label: key })
		cache.remember([key], false)
	}
}

async function readSubscriber(
	kit: KitClient,
	subscriberId: number | string,
): Promise<Record<string, unknown> | undefined> {
	const read = await kit.get<{ subscriber?: Record<string, unknown> }>(
		`/subscribers/${subscriberId}`,
		'secret',
	)
	const subscriber = read?.subscriber
	if (!subscriber || Object.keys(subscriber).length === 0) return undefined
	// Course Builder's shape: `tags` is the whole /tags response.
	const tags = await kit.get<unknown>(
		`/subscribers/${subscriber.id}/tags`,
		'key',
	)
	return { ...subscriber, tags }
}

function missingKeys(
	subscriber: Record<string, unknown>,
	keys: readonly string[],
) {
	const stored = subscriber.fields
	if (!stored || typeof stored !== 'object') return [...keys]
	return keys.filter((key) => !(key in (stored as Record<string, unknown>)))
}

function isFieldRefusal(error: unknown): boolean {
	return (
		error instanceof ConvertKitApiError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 429
	)
}

function endpointFor(listType: string | undefined): string {
	switch (listType) {
		case 'sequence':
			return 'sequences'
		case 'tag':
			return 'tags'
		case 'form':
		case undefined:
			return 'forms'
		default:
			throw new Error(`Unsupported Kit list type ${listType}`)
	}
}

function requiredListId(listId: string | number | undefined): string | number {
	if (listId === undefined || listId === null || listId === '') {
		throw new Error('No listId provided')
	}
	return listId
}

type KitClient = ReturnType<typeof kitClient>

function kitClient(deps: KitFieldContractDeps) {
	const fetchImpl = deps.fetch ?? globalThis.fetch
	const send = async <T>(path: string, init: RequestInit): Promise<T> => {
		const response = await fetchImpl(`${KIT_V3}${path}`, init)
		const text = await response.text()
		let data: unknown
		try {
			data = text ? JSON.parse(text) : undefined
		} catch {
			data = undefined
		}
		if (!response.ok) {
			const record = (data ?? {}) as Record<string, unknown>
			throw new ConvertKitApiError({
				message: `ConvertKit API request failed (${response.status}): ${String(record.error ?? record.message ?? text.slice(0, 200))}`,
				status: response.status,
				statusText: response.statusText,
				bodySnippet: text.slice(0, 200),
				responseHeaders: Object.fromEntries(response.headers.entries()),
			})
		}
		return data as T
	}
	const json = (method: string, body: unknown): RequestInit => ({
		method,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
		body: JSON.stringify(body),
	})
	return {
		apiSecret: deps.apiSecret,
		get: <T>(path: string, auth: 'key' | 'secret') => {
			const separator = path.includes('?') ? '&' : '?'
			const credential =
				auth === 'key'
					? `api_key=${encodeURIComponent(deps.apiKey ?? '')}`
					: `api_secret=${encodeURIComponent(deps.apiSecret ?? '')}`
			return send<T>(`${path}${separator}${credential}`, { method: 'GET' })
		},
		post: <T = unknown>(path: string, body: unknown) =>
			send<T>(path, json('POST', body)),
		put: <T = unknown>(path: string, body: unknown) =>
			send<T>(path, json('PUT', body)),
	}
}
