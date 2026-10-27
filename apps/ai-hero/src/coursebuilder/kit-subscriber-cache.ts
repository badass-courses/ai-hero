export const KIT_SUBSCRIBER_CACHE_TTL_MS = 3 * 60_000

/** Per-instance, bounded cache. Rejections and ambiguous empty responses are never cached. */
export function createKitSubscriberCache<T>(
	load: (id: string) => Promise<T | null | undefined>,
	{
		now = Date.now,
		ttlMs = KIT_SUBSCRIBER_CACHE_TTL_MS,
		maxEntries = 1_000,
	} = {},
) {
	const entries = new Map<string, { value: T | undefined; expiresAt: number }>()
	const pending = new Map<string, Promise<T | undefined>>()
	return {
		invalidate(id: string) {
			entries.delete(id)
			// An earlier in-flight read must not repopulate after a write.
			pending.delete(id)
		},
		async get(id: string): Promise<T | undefined> {
			const cached = entries.get(id)
			if (cached && cached.expiresAt > now())
				return structuredClone(cached.value)
			entries.delete(id)
			const existing = pending.get(id)
			if (existing) return structuredClone(await existing)
			let request!: Promise<T | undefined>
			request = (async () => {
				// Only the loader's explicit null means a verified subscriber 404.
				const loaded = await load(id)
				const value = loaded ?? undefined
				const cacheable = loaded !== undefined
				if (cacheable && pending.get(id) === request) {
					if (entries.size >= maxEntries)
						entries.delete(entries.keys().next().value!)
					entries.set(id, {
						value: structuredClone(value),
						expiresAt: now() + ttlMs,
					})
				}
				return value
			})()
			pending.set(id, request)
			try {
				return structuredClone(await request)
			} finally {
				if (pending.get(id) === request) pending.delete(id)
			}
		},
	}
}
